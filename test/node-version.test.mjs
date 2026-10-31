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
