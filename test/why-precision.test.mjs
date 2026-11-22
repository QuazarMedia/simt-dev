import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { readSqliteRows } from '../src/index/persist.mjs';
import { reindex } from '../src/index/store.mjs';
import { ensureGit, simt, tempDir } from './fixture.mjs';

test('why filters registry skills, explains supersession and refreshes stale governance', async () => {
  const root = await tempDir('why-precision-');
  const files = {
    'src/target.mjs': 'export function target() {}',
    'package.json': '{"name":"subject"}',
    '.github/CODEOWNERS': 'src/target.mjs @subject-owners\n',
    'simt.json': '{"gates":{"commands":{"memory":"node src/target.mjs"}}}',
    'docs/decisions/ADR-001-old.md': '---\nsimt-affects: ["src/target.mjs"]\n---\n# ADR-001 — Old policy\n\nStatus: superseded by ADR-002\n',
    'docs/decisions/ADR-002-current.md': '---\nsimt-affects: ["src/target.mjs", "simt why"]\nsimt-supersedes: ["ADR-001"]\n---\n'
      + '# ADR-002 — Current policy\n\nStatus: accepted\n',
    'rules/target.md': '---\nsimt-id: target-rule\nsimt-title: Review the target\nsimt-scope: ["src/target.mjs"]\n---\n# Rule\n',
  };
  for (let index = 0; index < 12; index += 1) files['src/other-' + index + '.mjs'] = 'export const item = 1;';
  const skills = [
    { name: 'native-node', summary: 'Tool for this file', paths: ['src/target.mjs'], stack: ['node'] },
    { name: 'tree-glob', summary: 'Every source file is not a governing skill', paths: ['src/**'], stack: ['node'] },
    { name: 'foreign-edge', summary: 'Requires the workers stack', paths: ['src/target.mjs'], stack: ['cloudflare'] },
  ];
  const registry = '.simt/skills.graph.json';
  files[registry] = JSON.stringify({ version: 1, skills });
  for (const [path, body] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, body);
  }
  await ensureGit(root);

  async function why(...args) {
    const result = await simt(['why', 'src/target.mjs', ...args, '--json'], { cwd: root });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  }
  const legacy = await why('--retrieval', 'v1');
  assert.ok(legacy.items.some(({ id }) => id === 'tree-glob'));
  assert.ok(legacy.items.some(({ id }) => id === 'foreign-edge'));
  const cold = await why();
  assert.equal(cold.basis, 'worktree');
  assert.deepEqual(cold.items.filter(({ kind }) => kind === 'skill').map(({ id }) => id), ['native-node']);
  assert.ok(cold.items.some(({ id }) => id === '@subject-owners'));
  assert.deepEqual(cold.historical, [{ kind: 'decision', id: 'ADR-001', detail: 'Old policy', supersededBy: 'ADR-002' }]);
  assert.deepEqual(cold.items.filter(({ kind }) => kind === 'decision').map(({ id }) => id), ['ADR-002']);

  await reindex(root);
  const warm = await why();
  assert.equal(warm.basis, 'sqlite');
  assert.deepEqual(warm.items, cold.items);
  assert.deepEqual(warm.historical, cold.historical);
  const { rows, error } = await readSqliteRows(root, 'select distinct kind from governance_edges order by kind');
  assert.equal(error, null);
  assert.deepEqual(rows.map(({ kind }) => kind), ['applies_to_stack', 'governs_command', 'governs_path', 'supersedes']);

  await writeFile(join(root, registry), JSON.stringify({ version: 1, skills: skills.slice(1) }));
  const edited = await why();
  assert.equal(edited.basis, 'worktree');
  assert.deepEqual(edited.items.filter(({ kind }) => kind === 'skill'), []);
  await reindex(root);
  assert.equal((await why()).basis, 'sqlite');

  const decision = join(root, 'docs/decisions/ADR-002-current.md');
  await writeFile(decision, files['docs/decisions/ADR-002-current.md'].replace('Current policy', 'Revised current policy'));
  const revised = await why();
  assert.equal(revised.basis, 'worktree');
  assert.ok(revised.items.some(({ detail }) => detail === 'Revised current policy'));
});
