// ADR-014: the workspace is configuration, and a single repository is first class.
//
// Every test here runs the tool the way a CONSUMER runs it, not the way the author
// runs it. The failure this file exists to prevent is specific: a tool that works
// only from its own source tree, tested only from its own source tree. So the
// degraded paths - no workspace, an unparseable config, an explicit workspace that
// does not exist - are exercised end to end through the CLI, because those are
// exactly the paths a checkout-resident test suite never reaches.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_FILE,
  PACKAGE_ROOT,
  WORKSPACE_REMEDY,
  configPaths,
  readUserConfig,
  resolveWorkspace,
} from '../src/workspace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt-dev.mjs');
const exec = promisify(execFile);

async function run(args, env = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      maxBuffer: 16 << 20,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function runJson(args, env = {}) {
  const { code, stdout, stderr } = await run([...args, '--json'], env);
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    /* left null so the assertion reports the raw output */
  }
  return { code, json, stdout, stderr };
}

async function scratch(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'simt-ws-'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  return dir;
}

/** A directory containing one git repository, so the heuristic would accept it. */
async function workspaceWithRepo(name = 'acme') {
  const dir = await scratch();
  await mkdir(join(dir, name, '.git'), { recursive: true });
  return dir;
}

// --- PACKAGE_ROOT -------------------------------------------------------------

test('PACKAGE_ROOT is the package directory, not its parent', () => {
  // Getting this wrong by one level shifts the sibling heuristic by a whole
  // directory, which produces a confidently wrong answer rather than an error.
  assert.ok(PACKAGE_ROOT.endsWith('/simt-dev'), PACKAGE_ROOT);
  assert.ok(!PACKAGE_ROOT.endsWith('/simt'), 'must be the package, not the workspace');
});

// --- configPaths --------------------------------------------------------------

test('configPaths: XDG_CONFIG_HOME wins when set, on any platform', () => {
  const paths = configPaths({ env: { XDG_CONFIG_HOME: '/xdg' }, platform: 'linux', home: '/home/dev' });
  assert.equal(paths[0], join('/xdg', 'simt-dev', CONFIG_FILE));
});

test('configPaths: without XDG it falls back to $HOME/.config on POSIX', () => {
  const paths = configPaths({ env: {}, platform: 'linux', home: '/home/dev' });
  assert.deepEqual(paths, [join('/home/dev', '.config', 'simt-dev', CONFIG_FILE)]);
});

test('configPaths: macOS offers the Apple location as a second candidate', () => {
  const paths = configPaths({ env: {}, platform: 'darwin', home: '/Users/dev' });
  assert.equal(paths[0], join('/Users/dev', '.config', 'simt-dev', CONFIG_FILE));
  assert.ok(
    paths.includes(join('/Users/dev', 'Library', 'Application Support', 'simt-dev', CONFIG_FILE)),
    'macOS best practice must be offered even though XDG comes first',
  );
});

test('configPaths: win32 uses APPDATA, and the path is still absolute', () => {
  const paths = configPaths({ env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }, platform: 'win32', home: 'C:\\Users\\dev' });
  assert.ok(paths.every((p) => p.endsWith(join('simt-dev', CONFIG_FILE))));
  assert.ok(paths.some((p) => p.includes('Roaming')));
});

test('configPaths: never repeats a path', () => {
  const paths = configPaths({ env: { XDG_CONFIG_HOME: '/home/dev/.config' }, platform: 'linux', home: '/home/dev' });
  assert.equal(new Set(paths).size, paths.length);
});

// --- readUserConfig -----------------------------------------------------------

test('readUserConfig: an absent config is "not configured", not an error', async () => {
  const result = await readUserConfig({ env: { XDG_CONFIG_HOME: '/nonexistent-dir-xyz' }, platform: 'linux', home: '/nonexistent-home-xyz' });
  assert.equal(result.exists, false);
  assert.equal(result.error, null, 'an absent file must not look like a broken one');
  assert.ok(result.searched.length > 0, 'the caller is told where it looked');
});

test('readUserConfig: a config that exists and parses is returned with the path that answered', async () => {
  const dir = await scratch({ [`simt-dev/${CONFIG_FILE}`]: JSON.stringify({ workspace: '/opt/repos' }) });
  const result = await readUserConfig({ env: { XDG_CONFIG_HOME: dir }, platform: 'linux', home: '/nonexistent' });
  assert.equal(result.exists, true);
  assert.equal(result.error, null);
  assert.equal(result.config.workspace, '/opt/repos');
  assert.ok(result.path.startsWith(dir), 'the winning path is the one named back');
});

test('readUserConfig: a config that exists and does not parse IS an error', async () => {
  // Silently ignoring it would send the reader looking for a configuration
  // problem in the wrong place.
  const dir = await scratch({ [`simt-dev/${CONFIG_FILE}`]: '{ not json' });
  const result = await readUserConfig({ env: { XDG_CONFIG_HOME: dir }, platform: 'linux', home: '/nonexistent' });
  assert.equal(result.exists, true);
  assert.match(result.error, /unparseable JSON/);
});

test('readUserConfig: the first existing candidate wins, not the most preferred one', async () => {
  const xdg = await scratch({ [`simt-dev/${CONFIG_FILE}`]: JSON.stringify({ workspace: '/from/xdg' }) });
  const result = await readUserConfig({ env: { XDG_CONFIG_HOME: xdg }, platform: 'darwin', home: '/nonexistent' });
  assert.equal(result.config.workspace, '/from/xdg');
});

// --- precedence ---------------------------------------------------------------

test('resolveWorkspace: --workspace beats the environment variable', async () => {
  const result = await resolveWorkspace(
    { workspace: '/from/flag' },
    { env: { SIMT_DEV_WORKSPACE: '/from/env', XDG_CONFIG_HOME: '/nonexistent' }, platform: 'linux', home: '/nonexistent' },
  );
  assert.equal(result.root, '/from/flag');
  assert.equal(result.source, 'flag');
});

test('resolveWorkspace: the environment variable beats the config file', async () => {
  const dir = await scratch({ [`simt-dev/${CONFIG_FILE}`]: JSON.stringify({ workspace: '/from/config' }) });
  const result = await resolveWorkspace(
    {},
    { env: { SIMT_DEV_WORKSPACE: '/from/env', XDG_CONFIG_HOME: dir }, platform: 'linux', home: '/nonexistent' },
  );
  assert.equal(result.root, '/from/env');
  assert.equal(result.source, 'env');
});

test('resolveWorkspace: the config file beats the sibling heuristic', async () => {
  const dir = await scratch({ [`simt-dev/${CONFIG_FILE}`]: JSON.stringify({ workspace: '/from/config' }) });
  const result = await resolveWorkspace({}, { env: { XDG_CONFIG_HOME: dir }, platform: 'linux', home: '/nonexistent' });
  assert.equal(result.root, '/from/config');
  assert.equal(result.source, 'config');
  assert.ok(result.detail.includes(CONFIG_FILE), 'it names the file that answered');
});

test('resolveWorkspace: --root is NOT treated as a workspace', async () => {
  // A repository is not its own parent. Resolving every source one directory too
  // low is the kind of wrong answer that reads as right.
  const result = await resolveWorkspace(
    { root: '/some/repo' },
    { env: { SIMT_DEV_WORKSPACE: '/from/env', XDG_CONFIG_HOME: '/nonexistent' }, platform: 'linux', home: '/nonexistent' },
  );
  assert.equal(result.source, 'env');
  assert.equal(result.root, '/from/env');
});

test('resolveWorkspace: a relative workspace is resolved, never taken literally', async () => {
  const result = await resolveWorkspace({ workspace: 'repos' }, { env: {}, platform: 'linux', home: '/nonexistent' });
  assert.ok(result.root.startsWith('/'), `${result.root} is not absolute`);
});

test('resolveWorkspace: an unparseable config is an error, and it names the file', async () => {
  const dir = await scratch({ [`simt-dev/${CONFIG_FILE}`]: 'nope' });
  const result = await resolveWorkspace({}, { env: { XDG_CONFIG_HOME: dir }, platform: 'linux', home: '/nonexistent' });
  assert.equal(result.error !== null, true);
  assert.equal(result.root, null);
  assert.ok(result.detail.includes(dir));
});

test('resolveWorkspace: an explicit workspace is trusted even when it does not exist', async () => {
  // The reader asked for it explicitly; the honest answer is "unavailable", which
  // the callers already print per skill. Silently substituting a different
  // directory would be worse than believing the reader.
  const result = await resolveWorkspace({ workspace: '/definitely/not/here' }, { env: {}, platform: 'linux', home: '/nonexistent' });
  assert.equal(result.root, '/definitely/not/here');
  assert.equal(result.source, 'flag');
  assert.equal(result.error, null);
});

test('resolveWorkspace: "off" declines the heuristic instead of guessing a directory', async () => {
  // Without this there is no way for a reader to refuse the guess, and no test
  // running from this checkout can reach the unconfigured path at all.
  for (const value of ['off', 'OFF', 'none', '0']) {
    const result = await resolveWorkspace({ workspace: value }, { env: {}, platform: 'linux', home: '/nonexistent' });
    assert.equal(result.source, 'disabled', `flag ${value} did not decline`);
    assert.equal(result.root, null);
  }
  const fromEnv = await resolveWorkspace({}, { env: { SIMT_DEV_WORKSPACE: 'off' }, platform: 'linux', home: '/nonexistent' });
  assert.equal(fromEnv.source, 'disabled');
  assert.match(fromEnv.detail, /declined/);
});

test('CLI: a workspace that was configured but has moved is named, not exploded', async () => {
  // 38 ENOENT lines is the failure this ADR exists to remove. A missing directory
  // the reader named is one fact, and the path is the actionable part.
  const { code, json } = await runJson(['graph', 'lint'], { SIMT_DEV_WORKSPACE: '/definitely/not/here' });
  assert.equal(code, 0, JSON.stringify(json.errors));
  assert.equal(json.verified, false);
  assert.ok(
    json.warnings.some((w) => w.includes('/definitely/not/here') && w.includes('does not exist')),
    `expected the missing path named once, got ${JSON.stringify(json.warnings)}`,
  );
});

test('configPaths: defaults to the real environment, not an empty one', () => {
  // This bug shipped. `env` defaulted to `{}` so tests could inject a fake, which
  // meant XDG_CONFIG_HOME - the one documented way to OVERRIDE the location - was
  // ignored on every real invocation. Every unit test passed `{env}` explicitly, so
  // only running the CLI could catch it.
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = '/xdg/from-the-environment';
  try {
    assert.ok(
      configPaths().includes('/xdg/from-the-environment/simt-dev/config.json'),
      `configPaths() ignored the environment: ${JSON.stringify(configPaths())}`,
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test('readUserConfig: defaults to the real environment too', async () => {
  const dir = await scratch({ [`simt-dev/${CONFIG_FILE}`]: JSON.stringify({ workspace: '/from/env-default' }) });
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    const result = await readUserConfig();
    assert.equal(result.exists, true, 'a no-options call must still find the config');
    assert.equal(result.config.workspace, '/from/env-default');
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

// --- the remedy ---------------------------------------------------------------

test('WORKSPACE_REMEDY names a real path and never "undefined"', async () => {
  // This exact bug shipped: the remedy ended in "or undefined" on a machine with no
  // XDG_CONFIG_HOME, because it indexed a candidate list that had one entry.
  assert.ok(!WORKSPACE_REMEDY.includes('undefined'), WORKSPACE_REMEDY);
  assert.ok(WORKSPACE_REMEDY.endsWith(CONFIG_FILE), WORKSPACE_REMEDY);
  assert.ok(WORKSPACE_REMEDY.includes('--workspace'), 'the flag is the answer that always works');
  assert.ok(WORKSPACE_REMEDY.includes('SIMT_DEV_WORKSPACE'));
  // It is a phrase, not a sentence: callers embed it after their own lead-in, so a
  // leading "set one with" produced "set one with set one with ...".
  assert.ok(!WORKSPACE_REMEDY.startsWith('set '), WORKSPACE_REMEDY);
});

// --- degraded mode, end to end -----------------------------------------------

test('CLI: a workspace that exists but holds none of the repos is named, not exploded', async () => {
  // Existence is not enough. Pointing --workspace at an empty directory produced 38
  // ENOENTs that read as a broken registry rather than a wrong pointer.
  const empty = await scratch();
  const { code, json } = await runJson(['graph', 'lint', '--workspace', empty]);
  assert.equal(code, 0, JSON.stringify(json.errors));
  assert.equal(json.verified, false);
  assert.ok(
    json.warnings.some((w) => w.includes('contains none of the repositories the registry names')),
    `expected the wrong-pointer finding, got ${JSON.stringify(json.warnings)}`,
  );
});

test('CLI: without a workspace the catalogue still lists every skill, with one line of context', async () => {
  const app = await scratch({ 'package.json': '{"name":"lonely"}' });
  const { code, stdout } = await run(['skills', 'index', '--root', app], { SIMT_DEV_WORKSPACE: 'off' });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /workspace none configured/);
  // Derived from the registry, not hardcoded: a hardcoded skill count is a
  // second place to update every time a node is added or removed, and the one
  // time it mattered it silently failed instead of saying why.
  const registry = JSON.parse(await readFile(resolve(HERE, '..', 'graph', 'skills.graph.json'), 'utf8'));
  assert.match(stdout, new RegExp(`${registry.skills.length} skills`));
  // One line about the workspace, not one ENOENT per skill.
  const noise = stdout.split('\n').filter((l) => l.includes('ENOENT'));
  assert.deepEqual(noise, [], `degraded mode must not emit ENOENTs: ${noise.join('\n')}`);
});

test('CLI: graph lint without a workspace warns and still lints the registry', async () => {
  const app = await scratch({ 'package.json': '{"name":"lonely"}' });
  const { code, json } = await runJson(['graph', 'lint'], { SIMT_DEV_WORKSPACE: 'off' });
  assert.equal(code, 0, 'an absent workspace is a fact, not a registry error');
  assert.equal(json.verified, false, 'it must say the bodies were not verified');
  assert.deepEqual(json.errors, []);
});

test('CLI: graph lint with a real workspace verifies bodies on disk', async () => {
  const { code, json } = await runJson(['graph', 'lint']);
  assert.equal(code, 0);
  assert.equal(json.verified, true);
});

test('CLI: skills show without a workspace explains instead of printing a bare path', async () => {
  const app = await scratch({ 'package.json': '{"name":"lonely"}' });
  const { code, stdout } = await run(['skills', 'show', 'slice-commit', '--root', app], {
    SIMT_DEV_WORKSPACE: 'off',
  });
  assert.equal(code, 0, 'show is still useful without a workspace');
  assert.match(stdout, /body unavailable/);
  assert.match(stdout, /--workspace|SIMT_DEV_WORKSPACE/);
});

test('CLI: skills install without a workspace refuses rather than half-installing', async () => {
  // The opposite of show: installing a body it cannot read is a failed install,
  // not a degraded mode.
  const app = await scratch({ 'package.json': '{"name":"lonely"}' });
  const { code, stderr } = await run(['skills', 'install', 'd1-safe-change', '--root', app, '--yes'], {
    SIMT_DEV_WORKSPACE: 'off',
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /no workspace/);
});

test('CLI: doctor reports which source answered', async () => {
  const app = await scratch({ 'package.json': '{"name":"lonely"}' });
  const { code, stdout } = await run(['doctor', '--root', app]);
  assert.equal(code, 0);
  assert.match(stdout, /^workspace\s+\S+.*\(heuristic: sibling of this package\)$/m);
});

test('CLI: an unparseable config makes doctor fail rather than fall through silently', async () => {
  const cfg = await scratch({ [`simt-dev/${CONFIG_FILE}`]: '{' });
  const app = await scratch({ 'package.json': '{"name":"lonely"}' });
  const { code, stderr } = await run(['doctor', '--root', app], { XDG_CONFIG_HOME: cfg, SIMT_DEV_WORKSPACE: 'off' });
  assert.notEqual(code, 0);
  assert.match(stderr, /unparseable JSON/);
});

test('CLI: a single repo with no workspace adopts and gates normally', async () => {
  const app = await scratch({ 'package.json': '{"name":"lonely"}' });
  const init = await run(['init', app, '--yes'], { SIMT_DEV_WORKSPACE: 'off' });
  assert.equal(init.code, 0, init.stderr);
  const check = await run(['check', '--root', app], { SIMT_DEV_WORKSPACE: 'off' });
  assert.equal(check.code, 0, check.stdout);
  assert.match(check.stdout, /CURRENT/);
});

test('CLI: --workspace is honoured end to end', async () => {
  const app = await scratch({ 'package.json': '{"name":"lonely"}' });
  const ws = await workspaceWithRepo();
  const { code, stdout } = await run(['doctor', '--root', app, '--workspace', ws], { SIMT_DEV_WORKSPACE: '/from/env' });
  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`^workspace\\s+${ws.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}  \\(flag: --workspace\\)$`, 'm'));
});