// Isolated workspaces for a benchmarked run.
//
// One base tree is exported per task and copied per run (review 0003 Q78): every arm and
// repetition used to unpack the same `git archive` again, which made the cost of the
// harness include the cost of exporting the repository. The copy is a fresh directory
// with no `.git` of its own until the arm has materialised, so two runs of one task can
// never see each other's edits.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STATE_DIR } from '../../../src/name.mjs';
import { LOCAL_DIR } from '../../../src/state.mjs';
import { sanitizedEnv, spawnBounded } from '../../../src/sys/proc.mjs';
import { materialiseArm } from './arms.mjs';

const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/** Run one bounded child process with a sanitised environment. */
export function runCmd(cmd, args, { cwd, env, input = null, timeoutMs = DEFAULT_GIT_TIMEOUT_MS } = {}) {
  return spawnBounded(cmd, args, { cwd, env: sanitizedEnv(env), input, timeoutMs });
}

/**
 * Apply a bounded, order-preserving pool over `items`.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>} results in input order
 */
export async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  const count = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

/**
 * Export one commit into a fresh directory: the tree every run of a task starts from.
 *
 * @param {string} root
 * @param {string} baseSha
 * @param {string} parentDir
 * @returns {Promise<string>} the directory holding the unpacked tree
 */
export async function prepareBaseTree(root, baseSha, parentDir) {
  const baseDir = await mkdtemp(join(parentDir, 'base-'));
  const archiveRes = await runCmd('git', ['archive', '--format=tar', baseSha], { cwd: root });
  if (archiveRes.code !== 0) {
    await rm(baseDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`git archive failed for ${baseSha}: ${archiveRes.stderr.toString('utf8').trim()}`);
  }
  const tarRes = await runCmd('tar', ['-xf', '-', '-C', baseDir], {
    cwd: baseDir,
    input: archiveRes.stdout,
  });
  if (tarRes.code !== 0) {
    await rm(baseDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`tar unpack failed for ${baseSha}: ${tarRes.stderr.toString('utf8').trim()}`);
  }
  return baseDir;
}

/**
 * Create the workspace one run is measured in: the base tree, the arm materialised over
 * it, one commit, and no tool state.
 *
 * @param {string} root
 * @param {string} baseSha
 * @param {object} armSpec
 * @param {object} [task]
 * @param {{parentDir?: string, baseDir?: string}} [options]
 * @returns {Promise<{slotDir: string, workDir: string, initialHead: string,
 *   env: Record<string, string>, promptPrefix: string}>}
 */
export async function prepareIsolatedWorkspace(root, baseSha, armSpec, task = {}, { parentDir, baseDir } = {}) {
  const slotDir = await mkdtemp(join(parentDir ?? tmpdir(), 'bench-run-'));
  const workDir = join(slotDir, 'workspace');
  await mkdir(workDir, { recursive: true });

  if (baseDir) {
    const copied = await runCmd('cp', ['-a', `${baseDir}/.`, workDir], { cwd: workDir });
    if (copied.code !== 0) {
      await rm(slotDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`copying the base tree failed for ${baseSha}: ${copied.stderr.toString('utf8').trim()}`);
    }
  } else {
    const archiveRes = await runCmd('git', ['archive', '--format=tar', baseSha], { cwd: root });
    if (archiveRes.code !== 0) {
      await rm(slotDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`git archive failed for ${baseSha}: ${archiveRes.stderr.toString('utf8').trim()}`);
    }
    const tarRes = await runCmd('tar', ['-xf', '-', '-C', workDir], { cwd: workDir, input: archiveRes.stdout });
    if (tarRes.code !== 0) {
      await rm(slotDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`tar unpack failed for ${baseSha}: ${tarRes.stderr.toString('utf8').trim()}`);
    }
  }

  // Lessons and local profiles live outside the archived commit, so an adopted
  // repository's memory reaches the arm without being written into its base tree.
  const rootLessonsDir = join(root, 'docs', 'lessons');
  const rootLessonFiles = (await readdir(rootLessonsDir).catch(() => [])).filter((f) => f.endsWith('.md'));
  if (rootLessonFiles.length > 0) {
    const destLessonsDir = join(workDir, 'docs', 'lessons');
    await mkdir(destLessonsDir, { recursive: true });
    for (const file of rootLessonFiles) {
      const target = join(destLessonsDir, file);
      if (!existsSync(target)) {
        await writeFile(target, await readFile(join(rootLessonsDir, file), 'utf8'), 'utf8');
      }
    }
  }

  const rootProfilesDir = join(root, STATE_DIR, 'profiles');
  const rootProfileFiles = (await readdir(rootProfilesDir).catch(() => [])).filter((f) => f.endsWith('.md'));
  if (rootProfileFiles.length > 0) {
    const destProfilesDir = join(workDir, STATE_DIR, 'profiles');
    await mkdir(destProfilesDir, { recursive: true });
    for (const file of rootProfileFiles) {
      await writeFile(join(destProfilesDir, file), await readFile(join(rootProfilesDir, file), 'utf8'), 'utf8');
    }
  }

  await runCmd('git', ['init', '-q'], { cwd: workDir });
  await runCmd('git', ['config', 'user.name', 'bench'], { cwd: workDir });
  await runCmd('git', ['config', 'user.email', 'bench@local'], { cwd: workDir });
  await runCmd('git', ['config', 'commit.gpgsign', 'false'], { cwd: workDir });

  // The repository exists before an arm materialises: the `brief` arm assembles its
  // packet from git's answer, which a directory that is not yet a repository cannot give.
  const { env, promptPrefix } = await materialiseArm(workDir, armSpec, task);
  // Assembling a packet writes tool state. It belongs to no arm, and leaving it in the
  // base commit would make the `brief` workspace differ by an index as well as by context.
  await rm(join(workDir, LOCAL_DIR), { recursive: true, force: true }).catch(() => {});

  await runCmd('git', ['add', '-A'], { cwd: workDir });
  const commitRes = await runCmd('git', ['commit', '-qm', 'base', '--allow-empty', '--no-verify'], {
    cwd: workDir,
  });
  if (commitRes.code !== 0) {
    await rm(slotDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`git commit failed in isolated workspace: ${commitRes.stderr.toString('utf8').trim()}`);
  }

  const headRes = await runCmd('git', ['rev-parse', 'HEAD'], { cwd: workDir });
  return { slotDir, workDir, initialHead: headRes.stdout.toString('utf8').trim(), env, promptPrefix };
}
