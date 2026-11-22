import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { impactCommand } from '../src/commands/impact.mjs';
import { impactTopology, traceImpact } from '../src/index/impact.mjs';
import { reindex } from '../src/index/store.mjs';
import { capture, ensureGit, tempDir } from './fixture.mjs';

test('impact follows the named export through a barrel, its callers and their tests', async () => {
  const root = await tempDir('impact-precision-');
  const sources = {
    'library.mjs': 'export function selected() {}\nexport function sibling() {}',
    'barrel.mjs': "export { selected as renamed, sibling } from './library.mjs';",
    'caller.mjs': "import { renamed } from './barrel.mjs';\nexport function invoke() { renamed(); }",
    'unrelated.mjs': "import { sibling } from './barrel.mjs';\nsibling();",
    'test/caller.test.mjs': "import { invoke } from '../caller.mjs';",
    'test/unrelated.test.mjs': "import '../unrelated.mjs';",
  };
  for (const [path, body] of Object.entries(sources)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, body);
  }
  await ensureGit(root);
  await reindex(root);

  const flags = { root, workspace: 'off', json: true };
  for (const target of ['selected', 'library.mjs#selected']) {
    const result = await capture(() => impactCommand([target], target.includes('#') ? flags : { ...flags, retrieval: 'v2' }));
    assert.equal(result.code, 0, result.stderr);
    const impact = JSON.parse(result.stdout);
    assert.equal(impact.symbol, 'selected');
    assert.deepEqual(impact.importers, ['barrel.mjs', 'caller.mjs']);
    assert.deepEqual(impact.tests, ['test/caller.test.mjs']);
    assert.deepEqual(impact.tiers.direct.map(({ path, hop }) => [path, hop]), [['barrel.mjs', 1], ['caller.mjs', 1]]);
    assert.deepEqual(impact.tiers.transitive.map(({ path, hop }) => [path, hop]), [['test/caller.test.mjs', 2]]);
    assert.equal(impact.conservativeFallback, false);
    assert.equal(impact.bindingCoverage.javascript.ratio, 1);
  }

  await writeFile(join(root, 'caller.mjs'), "export async function invoke() { return (await import('./library.mjs')).selected(); }");
  const dirty = await capture(() => impactCommand(['selected'], { ...flags, retrieval: 'v2' }));
  const impact = JSON.parse(dirty.stdout);
  assert.ok(impact.importers.includes('caller.mjs'));
  assert.ok(impact.tests.includes('test/caller.test.mjs'));
  assert.equal(impact.conservativeFallback, true);
});

test('direct and ordinary transitive paths survive a hub and report suppressed paths', () => {
  const spokes = Array.from({ length: 40 }, (_, index) => 'spoke-' + index + '.mjs');
  const files = ['target.mjs', 'z-direct.mjs', 'z-mid.mjs', 'hub.mjs', ...spokes];
  const edge = (src, dst) => ({ src, dst, kind: 'import' });
  const edges = [
    edge('hub.mjs', 'target.mjs'),
    edge('z-direct.mjs', 'target.mjs'),
    edge('z-mid.mjs', 'z-direct.mjs'),
    edge('z-mid.mjs', 'hub.mjs'),
    ...spokes.map((path) => edge(path, 'hub.mjs')),
  ];
  const topology = impactTopology({ files: files.map((path) => ({ path })), edges });
  const impact = traceImpact(topology, [{ file: 'target.mjs' }], { limit: 4 });
  assert.deepEqual(impact.importers, ['hub.mjs', 'z-direct.mjs', 'z-mid.mjs', 'spoke-0.mjs']);
  assert.equal(impact.tiers.transitive[0].path, 'z-mid.mjs');
  assert.equal(impact.tiers.hubMediated[0].path, 'spoke-0.mjs');
  assert.ok(impact.tiers.hubMediated[0].impactScore < impact.tiers.transitive[0].impactScore);
  assert.equal(impact.suppressedHubMediated, 39);
  assert.equal(impact.truncated, true);
});
