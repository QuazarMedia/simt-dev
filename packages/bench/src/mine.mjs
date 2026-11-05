// Task miner for `simt bench mine` (R01).
//
// Walks git history for non-merge commits that change both test files and
// implementation files, splits each candidate into `test.patch` and `gold.patch`,
// and validates in an isolated temporary worktree (twice, so flaky tests are
// dropped) that BASE + test.patch fails (RED) and BASE + test.patch + gold.patch
// passes (GOLD).
//
// Hidden test patches live in `~/.cache/simt-dev/vault/<repo-id>/<task-id>/`
// outside every worktree (RepoTrials / PatchGym), while deterministic task
// descriptors live in `.simt/bench/tasks/<id>.json`.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { STATE_DIR } from '../../../src/name.mjs';
import { readManifest } from '../../../src/projection/manifest.mjs';
import { packageVersion } from '../../../src/package-version.mjs';
import { TASK_SCHEMA_VERSION, normaliseTask } from '../../../src/measure/task-schema.mjs';
import { isTestPath } from '../../../src/testing/paths.mjs';
import { cleanupReports, dedupeSorted, readReports } from '../../../src/testing/parsers.mjs';
import { detectTestRunner } from '../../../src/testing/runners.mjs';
import { resolveVaultDir } from '../../../src/testing/vault.mjs';
import { spawnBounded } from '../../../src/sys/proc.mjs';

const exec = promisify(execFile);
export const DEFAULT_MINE_TARGET = 20;

/**
 * Test paths excluded by default, overridable via `simt.json` `bench.mine.exclude`
 * (review 0003 Q48: the pack integration test was hardcoded here, a repo fact, not a miner fact).
 */
const DEFAULT_EXCLUDES = ['test/pack.test.mjs'];
export function patchStats(patch, fileCount) {
  const text = Buffer.isBuffer(patch) ? patch.toString('utf8') : String(patch ?? '');
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) linesAdded += 1;
    else if (line.startsWith('-')) linesRemoved += 1;
  }
  return { files: fileCount, linesAdded, linesRemoved };
}

/**
 * Extract candidate commits from git history in a single `git log` pass.
 *
 * Keeps non-merge commits with at least one parent that modify both test paths
 * and implementation paths.
 *
 * @param {string} root
 * @returns {Promise<{ok: boolean, candidates: object[], error?: string}>}
 */
export async function listCandidates(root) {
  let stdout;
  try {
    ({ stdout } = await exec(
      'git',
      ['log', '--no-merges', '--min-parents=1', '--name-only', '--format=%x1e%H%x00%P%x00%s%x00%b%x1f'],
      { cwd: root, maxBuffer: 64 << 20 },
    ));
  } catch (error) {
    return { ok: false, candidates: [], error: error.stderr?.trim() || error.message };
  }

  const candidates = [];
  for (const record of stdout.split('\x1e')) {
    if (!record.trim()) continue;
    const sep = record.indexOf('\x1f');
    if (sep === -1) continue;
    const header = record.slice(0, sep);
    const filesBlock = record.slice(sep + 1);
    const [sha, parents, subject, body] = header.split('\0');
    if (!sha || !parents) continue;
    const base = parents.trim().split(/\s+/)[0];
    if (!base) continue;

    const changed = dedupeSorted(
      filesBlock
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const testFiles = changed.filter((f) => isTestPath(f));
    const implFiles = changed.filter((f) => !isTestPath(f));
    if (testFiles.length === 0 || implFiles.length === 0) continue;

    const cleanSubject = (subject ?? '').trim();
    const cleanBody = (body ?? '').trim();
    // Subject only by default. A commit body usually narrates the fix ("use x * x * x
    // here"), which hands the agent the answer and measures nothing; a repository whose
    // messages are curated can ask for the whole message with `bench.mine.prompt: "body"`
    // (review 0003 Q49).
    const prompt = cleanSubject;

    candidates.push({
      sha: sha.trim(),
      base,
      subject: cleanSubject,
      body: cleanBody,
      prompt,
      testFiles,
      implFiles,
    });
  }

  return { ok: true, candidates };
}

async function executeRunner(runner, worktree, env, timeoutMs) {
  const spec = runner.buildExec(worktree);
  // Remove what a previous run left behind before running: a stale report
  // would parse as this run's result, and a directory report accumulates
  // one XML per class across runs.
  for (const p of spec.reportPaths ?? []) {
    if (existsSync(p)) await rm(p, { recursive: true, force: true });
  }
  const res = await spawnBounded(spec.cmd, spec.args, { cwd: worktree, env, timeoutMs });
  const reportText = await readReports(spec.reportPaths);
  const parsed = runner.parse(res.stdout.toString('utf8'), reportText);
  await cleanupReports(spec.reportPaths);
  return {
    code: res.code,
    timedOut: res.timedOut,
    passed: parsed.passed,
    failed: parsed.failed,
  };
}

/**
 * Validate a single candidate commit in `worktree` by running RED twice and GOLD
 * twice, dropping any candidate whose test outcomes are not identical across both
 * passes.
 */
async function validateCandidate(
  root,
  worktree,
  candidate,
  { timeoutMs = 5000, exclude = DEFAULT_EXCLUDES, promptMode = 'subject' } = {},
) {
  // Skip commits that modify more than 4 test files, or that touch a path
  // the repository's manifest excludes (`simt.json` bench.mine.exclude,
  // defaulting to the pack integration test the committed corpus was mined
  // around): sweeping renames rather than self-contained benchmark tasks.
  if (
    candidate.testFiles.length > 4 ||
    candidate.testFiles.some((f) => exclude.includes(f))
  ) {
    return null;
  }

  let testPatch;
  let goldPatch;
  try {
    ({ stdout: testPatch } = await exec(
      'git',
      ['diff', '--binary', candidate.base, candidate.sha, '--', ...candidate.testFiles],
      { cwd: root, encoding: 'buffer', maxBuffer: 16 << 20 },
    ));
    ({ stdout: goldPatch } = await exec(
      'git',
      ['diff', '--binary', candidate.base, candidate.sha, '--', ...candidate.implFiles],
      { cwd: root, encoding: 'buffer', maxBuffer: 16 << 20 },
    ));
  } catch {
    return null;
  }
  if (!testPatch || testPatch.length === 0 || !goldPatch || goldPatch.length === 0) {
    return null;
  }

  await exec('git', ['reset', '--hard', 'HEAD'], { cwd: worktree }).catch(() => null);
  await exec('git', ['clean', '-fdx'], { cwd: worktree }).catch(() => null);
  const co = await spawnBounded('git', ['checkout', '-f', candidate.base], { cwd: worktree, timeoutMs: 15000 });
  if (co.code !== 0) return null;
  await exec('git', ['clean', '-fdx'], { cwd: worktree }).catch(() => null);

  const appliedRed = await spawnBounded('git', ['apply', '-'], { cwd: worktree, input: testPatch, timeoutMs: 15000 });
  if (appliedRed.code !== 0) return null;

  const runnableFiles = candidate.testFiles.filter((f) => existsSync(join(worktree, f)));
  if (runnableFiles.length === 0) return null;

  const runner = await detectTestRunner(worktree, runnableFiles);
  if (!runner) return null;

  const env = { ...process.env, SIMT_DEV_WORKSPACE: 'off', NO_COLOR: '1' };
  // Strip NODE_TEST_CONTEXT so child `node --test` invocations spawned from
  // inside a parent `node --test` run honour `--test-reporter=tap` instead of
  // emitting internal v8 subtest protocol frames.
  delete env.NODE_TEST_CONTEXT;

  // Pass 1 & 2 of RED: BASE + test.patch must fail reproducibly.
  const red1 = await executeRunner(runner, worktree, env, timeoutMs);
  if (red1.code === 0 || red1.timedOut) return null;
  const red2 = await executeRunner(runner, worktree, env, timeoutMs);
  if (red2.code === 0 || red2.timedOut) return null;
  if (!sameList(red1.failed, red2.failed) || !sameList(red1.passed, red2.passed)) {
    return null;
  }

  // Apply gold.patch on top of BASE + test.patch.
  const appliedGold = await spawnBounded('git', ['apply', '-'], { cwd: worktree, input: goldPatch, timeoutMs: 15000 });
  if (appliedGold.code !== 0) return null;

  // Pass 1 & 2 of GOLD: BASE + test.patch + gold.patch must pass reproducibly.
  const gold1 = await executeRunner(runner, worktree, env, timeoutMs);
  if (gold1.code !== 0 || gold1.timedOut || gold1.failed.length > 0) return null;
  const gold2 = await executeRunner(runner, worktree, env, timeoutMs);
  if (gold2.code !== 0 || gold2.timedOut || gold2.failed.length > 0) return null;
  if (!sameList(gold1.passed, gold2.passed)) return null;

  const redPassedSet = new Set(red1.passed);
  const redFailedSet = new Set(red1.failed);
  // Tests that failed in RED (or could not load before gold.patch existed) and
  // passed in GOLD are FAIL_TO_PASS; tests that passed in both are PASS_TO_PASS.
  const f2p = gold1.passed.filter((id) => redFailedSet.has(id) || !redPassedSet.has(id));
  const p2p = gold1.passed.filter((id) => redPassedSet.has(id) && !redFailedSet.has(id));
  if (f2p.length === 0) return null;

  // 12 hex chars of the source commit: the 7-char form plus a fixed `-01`
  // suffix could not disambiguate two tasks from the same commit (review 0003
  // Q48). Collisions are checked at write time, where the corpus is visible.
  const id = `t-${candidate.sha.slice(0, 12)}-01`;
  const gold = patchStats(goldPatch, candidate.implFiles.length);

  return {
    task: {
      schemaVersion: TASK_SCHEMA_VERSION,
      id,
      base: candidate.base,
      sourceCommit: candidate.sha,
      prompt:
        promptMode === 'body' && candidate.body
          ? `${candidate.subject}\n\n${candidate.body}`
          : candidate.subject,
      promptBasis: promptMode === 'body' && candidate.body ? 'body' : 'subject',
      testCmd: runner.displayCmd,
      f2p,
      p2p,
      gold,
      vault: `vault/${id}`,
    },
    testPatch,
    goldPatch,
  };
}

/**
 * Mine verified benchmark tasks from a repository's git history.
 *
 * When `apply` is false (the default without `--yes`, or under `--dry-run`),
 * candidates are discovered and reported without writing to `.simt/bench/tasks/`
 * or the vault. When `apply` is true, candidates are validated in isolated
 * temporary worktrees until `target` valid tasks are collected, and written
 * deterministically to disk.
 *
 * Writing is append-only: existing task files are left alone unless `replace`
 * is set, which restores the old "reflect exactly this history" semantics by
 * deleting files the current history does not reproduce (review 0003 Q48).
 *
 * @param {string} root
 * @param {{apply?: boolean, target?: number, concurrency?: number, timeoutMs?: number, replace?: boolean, env?: NodeJS.ProcessEnv}} [options]
 */
export async function mineTasks(
  root,
  {
    apply = false,
    target = DEFAULT_MINE_TARGET,
    concurrency = 4,
    timeoutMs = 5000,
    replace = false,
    env = process.env,
  } = {},
) {
  const absRoot = resolve(root);
  const listed = await listCandidates(absRoot);
  if (!listed.ok) {
    return { ok: false, error: listed.error };
  }

  // Repository-declared mining config (review 0003 Q48): an explicit option
  // wins, then the manifest, then the default.
  const { manifest } = await readManifest(absRoot);
  const benchCfg = manifest?.bench?.mine ?? {};
  const effectiveTimeout = benchCfg.timeoutMs ?? timeoutMs;
  const exclude = benchCfg.exclude ?? DEFAULT_EXCLUDES;
  const promptMode = benchCfg.prompt === 'body' ? 'body' : 'subject';

  const tasksDir = join(absRoot, STATE_DIR, 'bench', 'tasks');
  const vaultRoot = resolveVaultDir(absRoot, { env });

  if (!apply) {
    const preview = listed.candidates.slice(0, target).map((c) => ({
      id: `t-${c.sha.slice(0, 12)}-01`,
      base: c.base,
      sourceCommit: c.sha,
      subject: c.subject,
      testFiles: c.testFiles,
      implFiles: c.implFiles,
    }));
    return {
      ok: true,
      applied: false,
      root: absRoot,
      tasksDir,
      vaultRoot,
      candidatesCount: listed.candidates.length,
      tasks: preview,
    };
  }

  if (listed.candidates.length === 0) {
    return {
      ok: true,
      applied: true,
      root: absRoot,
      tasksDir,
      vaultRoot,
      candidatesCount: 0,
      tasks: [],
    };
  }

  const workerCount = Math.max(1, Math.min(concurrency, listed.candidates.length, target));
  const sandbox = await mkdtemp(join(tmpdir(), 'bench-mine-'));
  const worktrees = [];

  try {
    for (let i = 0; i < workerCount; i += 1) {
      // Nest each worktree inside its own subdirectory so `resolve(wt, '..')`
      // never looks like a sibling workspace (ADR-031).
      const wt = join(sandbox, `slot-${i}`, 'repo');
      await mkdir(dirname(wt), { recursive: true });
      await exec('git', ['worktree', 'add', '--detach', wt, 'HEAD'], { cwd: absRoot });
      worktrees.push(wt);
    }

    let cursor = 0;
    const validated = [];

    const runSlot = async (wt) => {
      while (validated.length < target) {
        const index = cursor;
        cursor += 1;
        if (index >= listed.candidates.length) break;
        const candidate = listed.candidates[index];
        const res = await validateCandidate(absRoot, wt, candidate, {
          timeoutMs: effectiveTimeout,
          exclude,
          promptMode,
        });
        if (res) {
          validated.push({ index, ...res });
        }
      }
    };

    await Promise.all(worktrees.map((wt) => runSlot(wt)));

    // Sort by commit history index so task selection is deterministic regardless
    // of which worker finished first.
    validated.sort((a, b) => a.index - b.index);
    const selected = validated.slice(0, target);

    await mkdir(tasksDir, { recursive: true });
    await mkdir(vaultRoot, { recursive: true, mode: 0o700 });
    // The hidden tests are the answer key: 0700 keeps every other local account out.
    // `mkdir` alone does not tighten a vault an earlier run created.
    await chmod(vaultRoot, 0o700).catch(() => {});

    // Mining is append-only (review 0003 Q48: `mineTasks(target 3)` once
    // deleted all 20 committed tasks and wrote 3 others). `replace` restores
    // the old "reflect exactly this history" semantics, and only it deletes.
    if (replace) {
      const existing = await readdir(tasksDir).catch(() => []);
      const keepNames = new Set(selected.map((entry) => `${entry.task.id}.json`));
      for (const name of existing) {
        if (name.endsWith('.json') && !keepNames.has(name)) {
          await rm(join(tasksDir, name), { force: true });
        }
      }
    }

    for (const entry of selected) {
      const taskPath = join(tasksDir, `${entry.task.id}.json`);
      // An id belongs to exactly one source commit. If a file with this id
      // holds a different commit, the 12-char prefix collided and guessing
      // which corpus the reader wants is worse than refusing.
      if (existsSync(taskPath) && !replace) {
        const prior = JSON.parse(await readFile(taskPath, 'utf8'));
        if (prior.sourceCommit !== entry.task.sourceCommit) {
          return {
            ok: false,
            applied: false,
            error: `id collision: ${taskPath} holds task from ${prior.sourceCommit}, mine produced ${entry.task.sourceCommit}; rerun with --replace to take over the corpus`,
          };
        }
      }
      // The miner is the writer, so it writes the schema a reader validates: a task file
      // that only becomes valid on load is a file two readers can disagree about.
      await writeFile(
        taskPath,
        `${JSON.stringify(normaliseTask(entry.task, { source: taskPath }), null, 2)}\n`,
        'utf8',
      );

      const taskVault = join(vaultRoot, entry.task.id);
      await mkdir(taskVault, { recursive: true, mode: 0o700 });
      await chmod(taskVault, 0o700).catch(() => {});
      await writeFile(join(taskVault, 'test.patch'), entry.testPatch);
      await writeFile(join(taskVault, 'gold.patch'), entry.goldPatch);
    }

    // The corpus records where it came from: which commit was HEAD when the
    // mine ran, the target, and the simt version that validated the tasks.
    // No timestamp — a re-mine at the same HEAD is byte-identical.
    const { stdout: headSha } = await exec('git', ['rev-parse', 'HEAD'], { cwd: absRoot });
    await writeFile(
      join(dirname(tasksDir), 'corpus.json'),
      `${JSON.stringify(
        { minedFrom: headSha.trim(), target, simtVersion: packageVersion() },
        null,
        2,
      )}\n`,
      'utf8',
    );

    return {
      ok: true,
      applied: true,
      root: absRoot,
      tasksDir,
      vaultRoot,
      candidatesCount: listed.candidates.length,
      tasks: selected.map((entry) => entry.task),
    };
  } finally {
    for (const wt of worktrees) {
      await exec('git', ['worktree', 'remove', '--force', wt], { cwd: absRoot }).catch(() => null);
    }
    await exec('git', ['worktree', 'prune'], { cwd: absRoot }).catch(() => null);
    await rm(sandbox, { recursive: true, force: true }).catch(() => null);
  }
}
function sameList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
