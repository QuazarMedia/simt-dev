// The runtime floor (review 0003 Q54).
//
// `package.json` declares `engines.node` and the launcher declares the same numbers in
// python; both installers only warn. The check itself is a pure comparison, so it can be
// tested without an older node on the machine, and the bootstrap's exit code is asserted
// here because it cannot import the constant without loading the CLI graph it protects.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { MIN_NODE, satisfiesMinimum } from '../src/node-version.mjs';

const exec = promisify(execFile);
const BIN = new URL('../bin/simt.mjs', import.meta.url).pathname;
const PY = new URL('../python/simt_dev/cli.py', import.meta.url).pathname;

test('the Node floor is compared numerically, not as a string', () => {
  assert.equal(MIN_NODE, '22.20.0');
  assert.equal(satisfiesMinimum('22.20.0'), true);
  assert.equal(satisfiesMinimum('22.20.1'), true);
  assert.equal(satisfiesMinimum('23.0.0'), true);
  assert.equal(satisfiesMinimum('22.19.9'), false);
  assert.equal(satisfiesMinimum('20.11.0'), false);
  // A pre-release suffix is not NaN: the numeric prefix is what runs.
  assert.equal(satisfiesMinimum('22.20.0-rc.1'), true);
  assert.equal(satisfiesMinimum('22.9.0'), false);
});

test('the floor is one number across every artefact that states it (ADR-206)', async () => {
  // Each of these is read by a different consumer - an installer, a bootstrap, a build
  // script, a launcher, a publish job - and before this test nothing compared the set.
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, `>=${MIN_NODE}`, 'package.json engines.node is not the floor');

  const py = await readFile(PY, 'utf8');
  const tuple = /MIN_NODE = \(([\d, ]+)\)/.exec(py)?.[1];
  assert.ok(tuple, 'the launcher pins no floor');
  assert.equal(tuple.replaceAll(' ', ''), MIN_NODE.split('.').join(','), 'the launcher floor differs from src/node-version.mjs');

  const build = await readFile(new URL('../scripts/build-sea.mjs', import.meta.url), 'utf8');
  assert.equal(/const NODE_VERSION = 'v([\d.]+)'/.exec(build)?.[1], MIN_NODE, 'the SEA base is not the floor');

  const publish = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  assert.ok(
    publish.includes(`node-version: '${MIN_NODE}'`),
    'the publish job runs on a node that is not the floor',
  );
});

test('the entry point checks the floor before it loads the CLI, and the launcher agrees', async () => {
  const bin = await readFile(BIN, 'utf8');
  assert.match(bin, /satisfiesMinimum\(process\.versions\.node\)/);
  assert.match(bin, /process\.exit\(5\)/, 'the bootstrap exits EXIT.UNSUPPORTED');
  assert.ok(
    bin.indexOf('node-version.mjs') < bin.indexOf('cli.mjs'),
    'the floor module is imported before the CLI is',
  );
  assert.doesNotMatch(bin, /from '\.\.\/src\/commands\//, 'the bootstrap loads no command module');

  const py = await readFile(PY, 'utf8');
  assert.match(py, /MIN_NODE = \(22, 20, 0\)/);
  assert.match(py, /version < MIN_NODE/);

  // The bootstrap still runs the CLI on a supported runtime.
  const { stdout } = await exec(process.execPath, [BIN, '--version'], { maxBuffer: 4 << 20 });
  assert.match(stdout, /\d+\.\d+\.\d+/);
});
