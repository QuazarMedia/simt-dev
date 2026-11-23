import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inferRetrievalIntent, kindPriorFor } from '../src/brief/kind.mjs';
import { rankMapV2 } from '../src/index/map-v2.mjs';
import { buildFieldedFtsBodies } from '../src/index/store.mjs';

test('kind prior prefers code on default/bugfix and docs on docs intent', async () => {
  const files = [
    { path: 'docs/guides/renewal.md' },
    { path: 'src/renewal.mjs' },
  ];
  const graph = {
    files,
    symbols: [],
    edges: [],
    fieldedRows: [
      ...buildFieldedFtsBodies('docs/guides/renewal.md', [], 'session renewal logged out early'),
      ...buildFieldedFtsBodies('src/renewal.mjs', [], 'session renewal logged out early ' + 'token refresh '.repeat(10)),
    ],
  };

  const bugfix = (await rankMapV2('.', graph, 'fix session renewal logged out early')).ranked;
  assert.equal(bugfix[0].path, 'src/renewal.mjs');

  const docs = (await rankMapV2('.', graph, 'document the session renewal guide')).ranked;
  assert.equal(docs[0].path, 'docs/guides/renewal.md');
});

test('test paths are excluded by default and included on tests intent or explicit test path', async () => {
  const files = [
    { path: 'src/cache.mjs' },
    { path: 'test/cache.test.mjs' },
  ];
  const graph = {
    files,
    symbols: [],
    edges: [],
    fieldedRows: [
      ...buildFieldedFtsBodies('src/cache.mjs', [], 'cache eviction policy'),
      ...buildFieldedFtsBodies('test/cache.test.mjs', [], 'cache eviction policy'),
    ],
  };

  const defaultRanked = (await rankMapV2('.', graph, 'fix cache eviction policy')).ranked;
  assert.equal(defaultRanked.some(({ path }) => path === 'test/cache.test.mjs'), false);

  const testIntentRanked = (await rankMapV2('.', graph, 'add regression test for cache eviction policy')).ranked;
  assert.equal(testIntentRanked[0].path, 'test/cache.test.mjs');

  const explicitRanked = (await rankMapV2('.', graph, 'fix test/cache.test.mjs')).ranked;
  assert.equal(explicitRanked[0].path, 'test/cache.test.mjs');
});

test('conventional-commit scope and singular/plural path stem boost intended module', async () => {
  const files = [
    { path: 'src/kernel/checks.mjs' },
    { path: 'src/kernel/rules.mjs' },
  ];
  const graph = {
    files,
    symbols: [],
    edges: [],
    fieldedRows: [
      ...buildFieldedFtsBodies('src/kernel/checks.mjs', [], 'repository import direction'),
      ...buildFieldedFtsBodies('src/kernel/rules.mjs', [], 'repository import direction'),
    ],
  };
  const ranked = (await rankMapV2('.', graph, 'feat(check): enforce repository import direction')).ranked;
  assert.equal(ranked[0].path, 'src/kernel/checks.mjs');
});

test('inferRetrievalIntent and kindPriorFor return deterministic multipliers', () => {
  assert.equal(inferRetrievalIntent('update the config json settings'), 'config');
  assert.ok(kindPriorFor('src/config/app.json', 'config', false) > kindPriorFor('src/app.mjs', 'config', false));
  assert.ok(kindPriorFor('src/app.mjs', 'default', false) > kindPriorFor('docs/app.md', 'default', false));
});
