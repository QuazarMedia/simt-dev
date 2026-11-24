// The tier split is a rule over the suite, so the rule is what gets tested.
//
// A classifier that put a CLI-spawning file in `unit` would make `test:unit` slow and, worse,
// would make a unit run depend on a subprocess it was meant to avoid. A classifier that dropped
// a file entirely would make one tier quietly run less than it claims, which is the failure mode
// of every hand-maintained list this replaces.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { GATE, INTEGRATION, UNIT, files, gateExcluded, tierOf, tiers } from './tier.mjs';

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

test('the gate view runs everything its exclusion does not name, and the exclusion is the bench and studio families', async () => {
  // The gate view is a complement, not a third partition: a file the exclusion names must
  // be out of the view and a file it does not name must be in, for every file that exists.
  // A view that silently ran less than its complement is the same failure as a hand-
  // maintained list dropping a tier (ADR-137, ADR-259).
  const all = (await readdir(HERE)).filter((name) => name.endsWith('.test.mjs'));
  const gate = new Set((await files(GATE)).map((p) => basename(p)));

  for (const name of all) {
    assert.equal(gate.has(name), !gateExcluded(name), `${name}: the gate view disagrees with its exclusion`);
  }
  assert.ok(gateExcluded('bench.test.mjs'));
  assert.ok(gateExcluded('pack-bench.test.mjs'));
  assert.ok(gateExcluded('studio-server.test.mjs'));
  assert.ok(!gateExcluded('ci.test.mjs'), 'a gate file is not excluded');
});
