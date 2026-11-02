// The tier split is a rule over the suite, so the rule is what gets tested.
//
// A classifier that put a CLI-spawning file in `unit` would make `test:unit` slow and, worse,
// would make a unit run depend on a subprocess it was meant to avoid. A classifier that dropped
// a file entirely would make one tier quietly run less than it claims, which is the failure mode
// of every hand-maintained list this replaces.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { INTEGRATION, UNIT, files, tierOf, tiers } from './tier.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('a file that spawns the CLI is integration', () => {
  assert.equal(tierOf("import { simt as simtCli } from './fixture.mjs';\n"), INTEGRATION);
  assert.equal(tierOf("import { execFile } from 'node:child_process';\n"), INTEGRATION);
  assert.equal(tierOf("export const BIN = new URL('../bin/simt.mjs', import.meta.url).pathname;\n"), INTEGRATION);
});

test('a file that imports modules and calls them is unit', () => {
  assert.equal(tierOf("import { plan } from '../src/projection/project.mjs';\n"), UNIT);
  assert.equal(tierOf(''), UNIT);
});

test('the two tiers partition the suite', async () => {
  const all = (await readdir(HERE)).filter((name) => name.endsWith('.test.mjs'));
  const unit = await files(UNIT);
  const integration = await files(INTEGRATION);

  assert.deepEqual([...unit, ...integration].sort(), all.map((name) => join(HERE, name)).sort());
  assert.equal(new Set([...unit, ...integration]).size, all.length);
  assert.deepEqual(tiers(), [UNIT, INTEGRATION]);
  assert.deepEqual(await files('all'), [...all].sort().map((name) => join(HERE, name)));
});

test('every unit file really has no child process', async () => {
  for (const path of await files(UNIT)) {
    assert.doesNotMatch(await readFile(path, 'utf8'), /child_process|spawnSync|execFile\(/, path);
  }
});
