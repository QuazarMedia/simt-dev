// The version pin: how simt-dev is installed, and the version a repository holds it to.
//
// Part 2 of S35. For a repository without npm, simt-dev is a global install and the only
// thing that knows which version it should be is the pin recorded in the manifest at
// adoption. A stale binary would run a different gate than CI does, so the mismatch fails
// the gate rather than warning. These tests cover the logic (assertVersionPin) and one of
// the two places it is wired in: `check` reports it as a blocking finding. The dispatcher
// path (the failed version gate) is tested in hooks.test.mjs, where the dispatcher lives.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import test, { after } from 'node:test';
import { packageVersion, hasNpm, assertVersionPin, describeVersion, checkoutSha } from '../src/package-version.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';

const exec = promisify(execFile);
const BIN = new URL('../bin/simt.mjs', import.meta.url).pathname;
const temps = [];

after(async () => {
  for (const t of temps) await exec('rm', ['-rf', t]);
});

/** Run the binary and report the outcome, exit code included (see ci.test.mjs). */
async function run(args, opts = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      ...opts,
      env: { ...process.env, NO_COLOR: '1', ...opts.env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('packageVersion is the running package version, never a guess', () => {
  // The version baked into every rendered artifact must be the one that produced it. It is
  // read from the package this code lives in, so it is correct whether the binary was
  // resolved from node_modules, a global install, or a source checkout.
  assert.match(packageVersion(), /^\d+\.\d+\.\d+$/);
});

test('hasNpm reports a package.json as npm, its absence as not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-ver-'));
  temps.push(root);
  assert.equal(await hasNpm(root), false, 'a repository without a package.json is not npm');
  await writeFile(join(root, 'package.json'), '{}\n');
  assert.equal(await hasNpm(root), true, 'a package.json makes it npm');
});

test('a matching or absent pin is not a mismatch', () => {
  assert.equal(assertVersionPin(undefined), null, 'no manifest');
  assert.equal(assertVersionPin({}), null, 'no projection');
  assert.equal(assertVersionPin({ projection: {} }), null, 'no recorded pin');
  assert.equal(assertVersionPin({ projection: { version: 'unknown' } }), null, 'an unreadable pin');
  assert.equal(assertVersionPin({ projection: { version: packageVersion() } }), null, 'a match');
});

test('a stale pin fails and names both versions', () => {
  const stale = `${packageVersion()}-x`;
  const msg = assertVersionPin({ projection: { version: stale } });
  assert.ok(typeof msg === 'string');
  assert.ok(msg.includes(`${MANIFEST_FILE} pins ${stale}`), msg);
  assert.ok(msg.includes(`running binary is ${packageVersion()}`), msg);
});

test('the install docs pin a release, never a literal version (Q05)', async () => {
  // The README once pinned 0.5.0 in four places while package.json moved on: any
  // literal `simt-dev@x.y.z` in prose rots on the next release. Install lines name
  // the package and tell the reader to pin; they never name the number.
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(!/simt-dev@\d/.test(readme), 'README must not pin a literal simt-dev@version');
  assert.ok(!/current published release is \*\*\d/.test(readme), 'README must not name the current release in prose');
  assert.ok(!/version after 0\.5\.0/.test(readme), 'README must not date the binary channel from a literal version');
});

test('describeVersion names the checkout past its tag (Q05)', async () => {
  // `main` 26 commits past v0.6.2 reported bare `0.6.2`: the number claimed a
  // release the bytes were not. In a checkout past its tag the SHA travels with
  // it; exactly on the tag the number stands alone; without git it degrades.
  const sha = checkoutSha();
  assert.ok(sha === null || /^[0-9a-f]+$/.test(sha), `checkout SHA is hex or absent, got ${sha}`);
  const described = describeVersion();
  assert.match(described, /^simt-dev \d+\.\d+\.\d+/);
  const { stdout } = await run(['--version']);
  assert.equal(stdout.trim(), described, '--version prints the described version');
});

test('check fails a repository whose pin does not match the running binary', async () => {
  // S35 part 2: adopt a repository (its manifest records the current version), then make
  // the pin disagree with the binary that runs. `check` must refuse on the mismatch and
  // name the one command that fixes it, because a stale global binary would run a
  // different gate than CI does.
  const root = await mkdtemp(join(tmpdir(), 'simt-ver-'));
  temps.push(root);
  await exec('git', ['init', '-q', '.'], { cwd: root });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fx', private: true }, null, 2));

  await run(['init', '--yes', '--surfaces', 'cursor'], { cwd: root });

  const manifestPath = join(root, MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.projection.version = `${packageVersion()}-x`;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const { code, stdout } = await run(['check'], { cwd: root });
  assert.notEqual(code, 0, 'a version mismatch is a blocking finding');
  assert.match(stdout, /VERSION-MISMATCH/);
  assert.match(stdout, /upgrade/);
});
