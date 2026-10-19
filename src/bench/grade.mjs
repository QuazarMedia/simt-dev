import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { runGates } from '../hooks/dispatcher.mjs';
import { packageVersion } from '../package-version.mjs';
import { readManifest } from '../projection/manifest.mjs';
import { detectTestRunner } from './mine.mjs';

const DEFAULT_GRADE_TIMEOUT_MS = 45_000;

function sanitizedEnv(extra = {}) {
  const env = { ...process.env, SIMT_DEV_WORKSPACE: 'off', ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST')) delete env[key];
  }
  return env;
}

function runCmd(cmd, args, { cwd, input = null, timeoutMs = DEFAULT_GRADE_TIMEOUT_MS } = {}) {
  return new Promise((resolveOutcome) => {
    const child = spawn(cmd, args, {
      cwd,
      env: sanitizedEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : null;

    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolveOutcome({
        code: 1,
        timedOut,
        stdout: Buffer.concat(out),
        stderr: Buffer.from(String(error.message ?? error)),
      });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolveOutcome({
        code: timedOut ? 124 : (code ?? 1),
        timedOut,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
      });
    });

    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Extract repository-relative file paths touched by a unified git diff.
 *
 * @param {Buffer|string} patch
 * @returns {string[]}
 */
export function extractPatchFiles(patch) {
  const text = Buffer.isBuffer(patch) ? patch.toString('utf8') : String(patch ?? '');
  const files = new Set();
  for (const line of text.split('\n')) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) files.add(match[2]);
  }
  return [...files].sort();
}

async function resetFilesToHead(workDir, initialHead, files) {
  for (const file of files) {
    const existsAtHead = await runCmd('git', ['cat-file', '-e', `${initialHead}:${file}`], { cwd: workDir });
    if (existsAtHead.code === 0) {
      await runCmd('git', ['checkout', '-f', initialHead, '--', file], { cwd: workDir });
    } else {
      await runCmd('git', ['rm', '-f', '--ignore-unmatch', '--', file], { cwd: workDir });
      await rm(join(workDir, file), { force: true }).catch(() => {});
    }
  }
}

async function evaluateDeclaredGates(workDir, testPassed) {
  const { exists, data: manifest, error } = await readManifest(workDir);
  if (!exists) return testPassed;
  if (error || !manifest) return false;

  const hasCustomTestCmd = Boolean(manifest?.gates?.commands?.test);
  const filterGates = (list) =>
    Array.isArray(list) ? list.filter((g) => g !== 'test' || hasCustomTestCmd) : [];

  const alignedManifest = {
    ...manifest,
    projection: {
      ...(manifest.projection ?? {}),
      version: packageVersion(),
    },
    gates: {
      ...(manifest.gates ?? {}),
      preCommit: filterGates(manifest?.gates?.preCommit),
      prePush: filterGates(manifest?.gates?.prePush),
    },
  };

  await runCmd('git', ['add', '-A'], { cwd: workDir });
  const preCommit = await runGates('pre-commit', { root: workDir, manifest: alignedManifest });
  const prePush = await runGates('pre-push', { root: workDir, manifest: alignedManifest });
  return testPassed && !preCommit.failed && !prePush.failed;
}

/**
 * Grade an isolated agent workspace after the agent finishes.
 *
 * Measures the agent's diff before applying the hidden verifier test patch, then resets
 * any test files touched by `test.patch` to `initialHead` so an agent cannot pass by
 * weakening or deleting the test suite.
 *
 * @param {string} workDir
 * @param {object} task
 * @param {{vaultRoot: string, initialHead: string, timeoutMs?: number}} options
 * @returns {Promise<{resolved: boolean, gatesPassed: boolean, diff: {files: number, outsideBlastRadius: number}, agentPatch: Buffer}>}
 */
export async function gradeWorkspace(workDir, task, { vaultRoot, initialHead, timeoutMs = DEFAULT_GRADE_TIMEOUT_MS }) {
  const taskVaultDir = join(vaultRoot, task.id);
  const [testPatch, goldPatch] = await Promise.all([
    readFile(join(taskVaultDir, 'test.patch')),
    readFile(join(taskVaultDir, 'gold.patch')).catch(() => Buffer.alloc(0)),
  ]);

  // Remove transient brief file if the `brief` arm or agent left one untracked, so it
  // is not counted as an implementation edit outside the task's blast radius.
  await runCmd('git', ['add', '-N', '.'], { cwd: workDir });
  const [diffNamesRes, diffPatchRes] = await Promise.all([
    runCmd('git', ['diff', '--name-only', initialHead], { cwd: workDir }),
    runCmd('git', ['diff', '--binary', initialHead], { cwd: workDir }),
  ]);

  const changedFiles = diffNamesRes.stdout
    .toString('utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => Boolean(f) && !f.startsWith('.simt-dev/'));

  const goldFiles = new Set(extractPatchFiles(goldPatch));
  const outsideBlastRadius =
    goldFiles.size > 0
      ? changedFiles.filter((file) => !goldFiles.has(file)).length
      : 0;
  const diff = {
    files: changedFiles.length,
    outsideBlastRadius,
  };

  const testPatchFiles = extractPatchFiles(testPatch);
  await resetFilesToHead(workDir, initialHead, testPatchFiles);

  const applyTest = await runCmd('git', ['apply', '-'], {
    cwd: workDir,
    input: testPatch,
    timeoutMs,
  });
  if (applyTest.code !== 0) {
    return {
      resolved: false,
      gatesPassed: false,
      diff,
      goldFiles: [...goldFiles],
      agentPatch: diffPatchRes.stdout,
    };
  }

  const runner = await detectTestRunner(workDir, testPatchFiles);
  if (!runner) {
    return {
      resolved: false,
      gatesPassed: false,
      diff,
      goldFiles: [...goldFiles],
      agentPatch: diffPatchRes.stdout,
    };
  }

  const execSpec = runner.buildExec(workDir);
  const runRes = await runCmd(execSpec.cmd, execSpec.args, { cwd: workDir, timeoutMs });
  const reportText = execSpec.reportPath
    ? await readFile(execSpec.reportPath, 'utf8').catch(() => '')
    : '';
  const parsed = runner.parse(runRes.stdout.toString('utf8'), reportText);
  const testRun = {
    code: runRes.code,
    timedOut: runRes.timedOut,
    passed: parsed.passed,
    failed: parsed.failed,
  };
  const passedSet = new Set(testRun.passed);
  const f2pResolved =
    Array.isArray(task.f2p) &&
    task.f2p.length > 0 &&
    task.f2p.every((id) => passedSet.has(id));
  const p2pIntact =
    Array.isArray(task.p2p) &&
    task.p2p.every((id) => passedSet.has(id));

  const resolved =
    !testRun.timedOut &&
    testRun.code === 0 &&
    testRun.failed.length === 0 &&
    f2pResolved &&
    p2pIntact;

  const gatesPassed = await evaluateDeclaredGates(
    workDir,
    !testRun.timedOut && testRun.code === 0 && testRun.failed.length === 0,
  );

  return {
    resolved,
    gatesPassed,
    diff,
    goldFiles: [...goldFiles],
    agentPatch: diffPatchRes.stdout,
  };
}
