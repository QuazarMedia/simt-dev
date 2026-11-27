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
  const longBody = Array.from({ length: 215 }, (_, idx) => `  const step_${idx} = ${idx};`).join('\n');
  await writeFile(join(root, 'a.mjs'), `import "./b.mjs";\nexport function handleTokenRefresh() {\n${longBody}\n  return step_0;\n}\n`);
  await writeFile(join(root, 'b.mjs'), 'import "./a.mjs";\nexport function b() { return 1; }\n');
  await writeFile(join(root, 'evidence.json'), JSON.stringify({
    units: [
      { id: 'u1', label: 'Token error', text: 'oauth refresh token expired during session renewal', scope: {} },
      { id: 'u2', label: 'Other', text: 'token unrelated renewal other', scope: {} },
    ],
  }));
  await writeFile(manifest, JSON.stringify({ brief: {}, limits: { graph: { cycles: true } } }));
  await ensureGit(root);
  await reindex(root);
  const index = join(root, SQLITE_FILE);
  const original = await readFile(index);

  const task = 'Fix handleTokenRefresh in a.mjs and document b.mjs';
  const defaultMap = await document(root, 'map', [], { task });
  assert.equal(defaultMap.retrieval, 'v3');
  assert.deepEqual(defaultMap.files, (await document(root, 'map', [], { task, retrieval: 'v3' })).files);
  const v2Map = await document(root, 'map', [], { task, retrieval: 'v2' });
  assert.equal(v2Map.retrieval, 'v2');
  const v3Map = await document(root, 'map', [], { task, retrieval: 'v3', explain: true });
  assert.equal(v3Map.retrieval, 'v3');
  assert.ok(v3Map.qpp && typeof v3Map.qpp === 'object');
  assert.equal((await document(root, 'map', [], { task, retrieval: 'v1' })).retrieval, undefined);

  const defaultBrief = await document(root, 'brief', [task]);
  assert.equal(defaultBrief.retrieval, 'v3');
  assert.equal(defaultBrief.subtasks.length, 2);
  assert.ok(Array.isArray(defaultBrief.scopes) && defaultBrief.scopes.some((s) => s.path === 'a.mjs' && s.name === 'handleTokenRefresh'));
  const v2Brief = await document(root, 'brief', [task], { retrieval: 'v2' });
  assert.equal(v2Brief.retrieval, 'v2');
  assert.equal(v2Brief.subtasks.length, 2);
  const v3SingleBrief = await document(root, 'brief', ['Fix handleTokenRefresh in a.mjs']);
  assert.equal(v3SingleBrief.retrieval, 'v3');
  assert.ok(Array.isArray(v3SingleBrief.scopes) && v3SingleBrief.scopes.some((s) => s.path === 'a.mjs' && s.name === 'handleTokenRefresh'));
  assert.equal((await document(root, 'brief', [task], { retrieval: 'v1' })).subtasks, undefined);

  assert.equal((await promptOptIn(root)).retrieval, 'v3');
  assert.ok((await document(root, 'check')).findings.some(({ status }) => status === 'import-cycle'));
  assert.ok(Array.isArray((await document(root, 'why', ['a.mjs'])).witnesses?.command));
  assert.ok(Array.isArray((await document(root, 'why', ['a.mjs'], { retrieval: 'v2' })).witnesses?.command));
  assert.equal((await document(root, 'why', ['a.mjs'], { retrieval: 'v1' })).witnesses, undefined);

  const v3Impact = await document(root, 'impact', ['a.mjs']);
  assert.ok(Array.isArray(v3Impact.importers));
  const v3Rank = await document(root, 'knowledge rank', [], { input: join(root, 'evidence.json'), query: 'oauth refresh token expired' });
  assert.equal(v3Rank.retrieval, 'v3');
  assert.equal(v3Rank.ranked[0]?.id, 'u1');

  await writeFile(manifest, JSON.stringify({ brief: { retrieval: 'v2' } }));
  assert.equal((await promptOptIn(root)).retrieval, 'v2');
  await writeFile(manifest, JSON.stringify({ brief: { retrieval: 'v1' } }));
  assert.equal((await promptOptIn(root)).retrieval, 'v1');
  assert.ok((await document(root, 'check')).findings.every(({ status }) => status !== 'import-cycle'));
  assert.deepEqual(await readFile(index), original);
});
