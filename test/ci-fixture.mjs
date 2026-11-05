// Shared fixtures for the CI suites: the gate path, a runner that reports the exit code,
// and the two repository shapes the workflow and Dependabot tests both start from.
// Extracted when the suite crossed the line ceiling; two copies of a repo builder would
// be two ideas of what a CI repo is.

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { WORKFLOWS_DIR } from '../src/ci/workflow.mjs';
import { PACKAGE_NAME } from '../src/name.mjs';
import { PACKAGE_ROOT } from '../src/workspace.mjs';
import { keepTemp, simt as simtCli } from './fixture.mjs';

const CI = join(PACKAGE_ROOT, 'scripts', 'ci.mjs');
const exec = promisify(execFile);
const BIN = new URL('../bin/simt.mjs', import.meta.url).pathname;

/**
 * Run the binary and report the outcome, exit code included.
 *
 * `promisify(execFile)` rejects on a non-zero exit, which is the right default for a
 * helper that is asserting a command succeeded — and the wrong one for every test
 * about a command that must fail. Without this, a test for a refusal can only read
 * stdout if it catches the rejection, and the code it was supposed to check is the
 * code in the error.
 */
const run = (args, opts = {}) => simtCli(args, { ...opts, bin: CI, env: { NO_COLOR: '1', ...opts.env } });

/**
 * A repo that already runs GitHub Actions.
 *
 * One existing workflow file, because the directory is the only signal that this repo
 * is a CI repo, and a signal nobody can produce by accident is not one to trust.
 */
async function actionsRepo(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-ci-'));
  keepTemp(root);
  await exec('git', ['init', '-q', '.'], { cwd: root });
  // A repo that has completed adoption pins the tool before the gate can run from
  // node_modules. Without the pin, `check` correctly reports an unresolvable gate;
  // leaving it out made these tests depend on the author's global `simt` (ADR-031).
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fx', private: true, devDependencies: { [PACKAGE_NAME]: '0.0.0' } }, null, 2),
  );
  await mkdir(join(root, WORKFLOWS_DIR), { recursive: true });
  await writeFile(join(root, WORKFLOWS_DIR, 'build.yml'), 'name: build\n');
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), body);
  }
  return root;
}

/** A repo with no `.github` at all. */
async function plainRepo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-ci-'));
  keepTemp(root);
  await exec('git', ['init', '-q', '.'], { cwd: root });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fx', private: true, devDependencies: { [PACKAGE_NAME]: '0.0.0' } }, null, 2),
  );
  return root;
}

export { CI, BIN, exec, run, actionsRepo, plainRepo };
