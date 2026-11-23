import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { assembleBrief } from '../src/brief/assemble.mjs';
import { reindex } from '../src/index/store.mjs';
import { ensureGit, tempDir } from './fixture.mjs';

test('composite intent projection locates tests, config, and docs from semantic code anchors', async () => {
  const root = await tempDir('brief-intent-proj-');
  const files = {
    'simt.json': '{"brief":{"retrieval":"v2"}}',
    'src/billing.mjs': 'export function chargeInvoice() { return true; } // invoice payment retry\n',
    'test/billing.test.mjs': "import { chargeInvoice } from '../src/billing.mjs';\n",
    'src/config/billing.json': '{"enabled":true}\n',
    'docs/guides/billing.md': '# Billing\nInvoice payment retry behavior.\n',
    'src/auth.mjs': 'export function authenticate() { return true; }\n',
    'test/auth.test.mjs': "import { authenticate } from '../src/auth.mjs';\n",
    'src/config/auth.json': '{"enabled":false}\n',
    'docs/guides/auth.md': '# Auth\nAuthentication guide.\n',
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await ensureGit(root);
  await reindex(root, { fielded: true });

  const task = 'Fix invoice payment retry logic, add regression tests for invoice retry, enable billing in the config, and document invoice retry in the guide';
  const result = await assembleBrief({ root, task, retrieval: 'v2', budget: 4096 });
  assert.equal(result.composite.subtasks.length, 4);
  const [t1, t2, t3, t4] = result.composite.subtasks;
  assert.equal(t1.files[0].path, 'src/billing.mjs');
  assert.equal(t2.files[0].path, 'test/billing.test.mjs');
  assert.equal(t3.files[0].path, 'src/config/billing.json');
  assert.equal(t4.files[0].path, 'docs/guides/billing.md');
});

test('negative-scope exclusions apply across projected test and config targets', async () => {
  const root = await tempDir('brief-intent-excl-');
  const files = {
    'simt.json': '{"brief":{"retrieval":"v2"}}',
    'src/cache.mjs': 'export function evictCache() { return 1; } // cache eviction\n',
    'test/cache.test.mjs': "import { evictCache } from '../src/cache.mjs';\n",
    'src/config/cache.json': '{"enabled":true}\n',
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await ensureGit(root);
  await reindex(root, { fielded: true });

  const task = 'Fix cache eviction and update config without modifying src/config/cache.json';
  const result = await assembleBrief({ root, task, retrieval: 'v2' });
  const configSubtask = result.composite.subtasks[1];
  assert.ok(!configSubtask.files.some(({ path }) => path === 'src/config/cache.json'));
});
