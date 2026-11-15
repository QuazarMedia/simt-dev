// The two halves of one gap: `graph lint` skipped every vendored node, so a
// packaged body could drift from its declaration forever. simt-commands did -
// 4161 declared, 6689 on disk - and `skills install` refused every consumer.
// A package-shipped body is now measured from the package root; a
// workspace-member body is still skipped, because its absence from a lone
// clone is absence, not drift.
//
// Separate from test/graph.test.mjs because that file is at the 400-line
// review trigger, and this is the shape review 0004 names for a lane that
// outgrows it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from '../src/graph/load.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = await readFile(resolve(ROOT, 'graph', 'skills.graph.json'), 'utf8');

/** Deep clone so each test can mutate freely. */
function clone() {
  return JSON.parse(REGISTRY);
}

test('lint: a vendored source that ships with the package is byte-verified (regression)', async () => {
  // simt-commands ships with the package root. Every vendored node used to skip
  // the on-disk check entirely, so a body that grew outlived its declaration -
  // 4161 declared, 6689 on disk - and `skills install` refused every consumer.
  // A stale count on a packaged body must now fail the load.
  const dir = await mkdtemp(join(tmpdir(), 'simt-vend-'));
  try {
    const g = clone();
    const source = g.skills.find((s) => s.name === 'simt-commands').sources[0];
    source.bytes += 1;
    const reg = join(dir, 'registry.json');
    await writeFile(reg, JSON.stringify(g));
    const { ok, errors } = await loadRegistry(reg);
    assert.equal(ok, false);
    assert.ok(
      errors.some(
        (e) =>
          e.includes('simt-commands: simt-dev/skills/simt-commands') &&
          /declared \d+ bytes, on disk \d+/.test(e),
      ),
      `expected a byte-count error, got: ${errors.join('\n')}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lint: a packaged body that is missing is an error, not a silent skip', async () => {
  // The other half: the check must fire on absence of the shipped body too,
  // not only on a size disagreement.
  const dir = await mkdtemp(join(tmpdir(), 'simt-vend2-'));
  try {
    const g = clone();
    const source = g.skills.find((s) => s.name === 'simt-commands').sources[0];
    source.path = 'skills/does-not-ship';
    const reg = join(dir, 'registry.json');
    await writeFile(reg, JSON.stringify(g));
    const { ok, errors } = await loadRegistry(reg);
    assert.equal(ok, false);
    assert.ok(
      errors.some((e) => e.includes('simt-commands') && /does not exist/.test(e)),
      `expected a missing-path error, got: ${errors.join('\n')}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
