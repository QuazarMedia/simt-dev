import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { promptOptIn } from '../src/agenthooks/prompt.mjs';
import { SQLITE_FILE } from '../src/index/persist.mjs';
import { reindex } from '../src/index/store.mjs';
import { run } from '../src/run.mjs';
import { ensureGit, tempDir } from './fixture.mjs';

async function document(root, command, args = [], flags = {}) {
  const result = await run(command, { root, args, flags: { ...flags, json: true } });
  assert.ok(result.documents[0], JSON.stringify(result.error));
  return result.documents[0];
}

test('retrieval mode and graph switches restore documented behavior on the same index', async () => {
  const root = await tempDir('retrieval-rollout-');
  const manifest = join(root, 'simt.json');
  await writeFile(join(root, 'a.mjs'), 'import "./b.mjs";\nexport function a() { return 1; }\n');
  await writeFile(join(root, 'b.mjs'), 'import "./a.mjs";\nexport function b() { return 1; }\n');
  await writeFile(manifest, JSON.stringify({ brief: {}, limits: { graph: { cycles: true } } }));
  await ensureGit(root);
  await reindex(root);
  const index = join(root, SQLITE_FILE);
  const original = await readFile(index);

  const task = 'Fix a.mjs and document b.mjs';
  const defaultMap = await document(root, 'map', [], { task });
  assert.equal(defaultMap.retrieval, 'v2');
  assert.deepEqual(defaultMap.files, (await document(root, 'map', [], { task, retrieval: 'v2' })).files);
  assert.equal((await document(root, 'map', [], { task, retrieval: 'v1' })).retrieval, undefined);
  const defaultBrief = await document(root, 'brief', [task]);
  assert.equal(defaultBrief.retrieval, 'v2');
  assert.equal(defaultBrief.subtasks.length, 2);
  assert.equal((await document(root, 'brief', [task], { retrieval: 'v1' })).subtasks, undefined);
  assert.equal((await promptOptIn(root)).retrieval, 'v2');
  assert.ok((await document(root, 'check')).findings.some(({ status }) => status === 'import-cycle'));
  assert.ok(Array.isArray((await document(root, 'why', ['a.mjs'])).witnesses?.command));
  assert.equal((await document(root, 'why', ['a.mjs'], { retrieval: 'v1' })).witnesses, undefined);

  await writeFile(manifest, JSON.stringify({ brief: { retrieval: 'v1' } }));
  assert.equal((await promptOptIn(root)).retrieval, 'v1');
  assert.ok((await document(root, 'check')).findings.every(({ status }) => status !== 'import-cycle'));
  assert.deepEqual(await readFile(index), original);
});
