import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { PACKAGE_NAME } from '../src/name.mjs';
import { after, test } from 'node:test';

import { GATE_KINDS, GATES, FORMATTABLE, gateNames } from '../src/hooks/gates.mjs';
import { EVENTS, HOOKS_DIR, HOOKS_DIR_LEGACY, HOOKS_PATH_KEY, SHIM_MARKER, fileFor, renderChainedShim, renderShim } from '../src/hooks/shim.mjs';
import { hasScript, resolveGate, resolveStagedTool } from '../src/hooks/resolve.mjs';
import { classifyPush, DEFAULT_SKIP_EXTENSIONS, parsePushedRefs, renderGateReport, runGates, stagedFiles } from '../src/hooks/dispatcher.mjs';
import { recordRun } from '../src/ledger/index.mjs';
import { packageVersion } from '../src/package-version.mjs';
import { readCapability } from '../src/hooks/capability.mjs';
import * as gateModule from '../src/projection/manifest.mjs';
import { git, cmd, keepTemp } from './fixture.mjs';
import { CLI } from '../src/name.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';
import { simt as simtCli } from './fixture.mjs';

const run = (args) => simtCli(args, { maxBuffer: 16 << 20 }).then(({ code, stdout, stderr }) => ({ code, out: stdout + stderr }));

const exec = promisify(execFile);
const BIN = new URL('../bin/simt.mjs', import.meta.url).pathname;

async function fixture({ scripts, manifest, files = {}, binaries = [], formatter = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-hooksd-'));
  keepTemp(root);
  await exec('git', ['init', '-q', '.'], { cwd: root });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fx', scripts: scripts ?? {} }, null, 2));
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
  }
  if (manifest) await writeFile(join(root, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  // `formatter: true` gives prettier a body that rewrites what it is handed, which is
  // the only shape that can show whether the hook re-staged the formatter's output -
  // an `exit 0` stub passes every assertion without exercising anything.
  const body = formatter ? '#!/bin/sh\nfor f in "$@"; do printf "FORMATTED\\n" > "$f"; done\n' : '#!/bin/sh\nexit 0\n';
  for (const b of binaries) {
    const path = join(root, 'node_modules', '.bin', b);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
    await chmod(path, 0o755);
  }
  return root;
}

/**
 * Put a specific blob in the index for `file` while the working tree keeps more,
 * which is what `git add -p` produces. Written as blob plumbing rather than by
 * driving `git add -p`, because an interactive prompt split differently on a
 * different git version would make this helper a second source of truth for what
 * "partially staged" means.
 */
async function stageBlob(root, file, content) {
  const scratch = join(root, '.stage-scratch');
  await writeFile(scratch, content);
  const { stdout } = await exec('git', ['hash-object', '-w', '--', scratch], { cwd: root });
  // `--add` because a fixture repo has no commit yet, so the path is not in the index
  // and git refuses to add it without being told this is intentional.
  await exec('git', ['update-index', '--add', '--cacheinfo', `100644,${stdout.trim()},${file}`], { cwd: root });
  await exec('rm', ['-f', scratch], { cwd: root });
}

async function stagedContent(root, file) {
  const { stdout } = await exec('git', ['show', `:${file}`], { cwd: root });
  return stdout;
}

async function simt(args, cwd) {
  return exec(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
}

/**
 * The same, for a command that is expected to report a problem and exit non-zero.
 *
 * `hooks status` exits 1 on a stale shim, which is correct behaviour, and `exec`
 * turns that into a thrown error carrying the very output under test. Reading a
 * failing command's output is the whole point of the tests below.
 */
async function simtAllowingFailure(args, cwd) {
  try {
    return await simt(args, cwd);
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

// ---------------------------------------------------------------- shim

const SKIP_TEST = { maxCommits: 2, paths: ['**/*.md', 'docs/**'] };

/**
 * A fixture repo with a base commit and one commit on top, plus the stdin line
 * git feeds a pre-push that pushes the top commit to an existing branch: the
 * remote sha is the base, so the diff is exactly the top commit.
 */
async function twoCommitPush({ files = {}, topFiles = {}, manifest }) {
  const root = await fixture({ scripts: { test: 'exit 0' }, files, manifest });
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'base'], { cwd: root });
  const { stdout: base } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  for (const [name, body] of Object.entries(topFiles)) {
    await mkdir(join(root, dirname(name)), { recursive: true });
    await writeFile(join(root, name), body);
  }
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'top'], { cwd: root });
  const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  return { root, base: base.trim(), head: head.trim(), pushed: `refs/heads/main ${head.trim()} refs/heads/main ${base.trim()}\n` };
}

async function recordGreenSuite(root) {
  await recordRun(root, { cmd: 'npm test', exit: 0, ms: 120, output: '1580 pass, 0 fail', gate: 'test', kind: 'test' });
}

async function installedRepo(gates) {
  const root = await fixture({
    scripts: { lint: 'true', test: 'true' },
    manifest: { gates },
    binaries: ['lint', 'test'],
  });
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  return root;
}

/** A repo-local helper, because `simt` is the binary under test. */
const setManifest = async (root, gates) => {
  await writeFile(join(root, MANIFEST_FILE), JSON.stringify({ id: 'r', stack: [], surfaces: ['cursor'], gates }, null, 2));
};

const hooksPath = (root) =>
  exec('git', ['config', '--get', HOOKS_PATH_KEY], { cwd: root })
    .then((r) => r.stdout.trim())
    .catch(() => null);

export { run, exec, BIN, fixture, stageBlob, stagedContent, simt, simtAllowingFailure, SKIP_TEST, twoCommitPush, recordGreenSuite, installedRepo, setManifest, hooksPath };
