import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { checkRepo } from '../src/commands/sync.mjs';
import { runDeclaredChecks } from '../src/kernel/checks.mjs';
import { manifestProblems, unknownKeys } from '../src/manifest/schema.mjs';
import { git } from './fixture.mjs';

const marker = { source: 'house.md', body: '- Respect the layers. <!-- simt-check: import-direction -->' };
const forbid = { from: 'src/util/**', to: 'src/commands/**', reason: 'keep utilities independent' };

async function repo(files) {
  const root = await mkdtemp(join(tmpdir(), 'simt-architecture-'));
  await git(['init', '-q', root]);
  for (const [path, body] of Object.entries(files)) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  return root;
}

test('architecture is repository-owned and validates the shapes it reads', () => {
  const architecture = {
    layers: [{ id: 'utilities', paths: ['src/util/**'], mayImport: ['undeclared-layer'] }],
    forbid: [forbid],
  };
  assert.deepEqual(manifestProblems({ architecture }), []);
  assert.deepEqual(unknownKeys({ architecture }), []);
  for (const invalid of [null, {}, { forbid: [{ ...forbid, from: '../outside' }] },
    { forbid: [{ ...forbid, transitive: 'true' }] }, { layers: [...architecture.layers, ...architecture.layers] }]) {
    assert.match(manifestProblems({ architecture: invalid })[0], /^architecture/);
  }
});

test('declared layers report the originating specifier and removal clears the finding', async () => {
  const src = 'src/util/a.mjs';
  const dst = 'src/commands/b.mjs';
  const root = await repo({
    [src]: '\nimport "../commands/b.mjs";\n',
    [dst]: 'export const x = 1;\n',
  });
  const manifest = { architecture: { layers: [
    { id: 'util', paths: ['src/util/**'], mayImport: [] },
    { id: 'commands', paths: ['src/commands/**'], mayImport: ['util'] },
  ] } };
  assert.deepEqual(await runDeclaredChecks(root, [], manifest), []);
  assert.equal((await runDeclaredChecks(root, [marker], {}))[0].status, 'check-unbuilt');
  const [hit] = await runDeclaredChecks(root, [marker], manifest);
  assert.equal(hit.status, 'import-direction-violation');
  assert.equal(hit.file, src);
  assert.equal(hit.line, 2);
  assert.equal(hit.specifier, '../commands/b.mjs');
  assert.deepEqual(hit.witness, [src, dst]);

  await git(['-C', root, 'add', '.']);
  await git(['-C', root, 'commit', '-qm', 'fixture']);
  await writeFile(join(root, src), 'export const y = 2;\n');
  assert.deepEqual(await runDeclaredChecks(root, [marker], manifest), []);
});

test('forbidden reachability uses a shortest deterministic witness through a cycle', async () => {
  const src = 'src/util/a.mjs';
  const dst = 'src/commands/b.mjs';
  const root = await repo({
    [src]: 'export { x } from "../via/z.mjs";\nexport { x as y } from "../via/a.mjs";\n',
    'src/via/a.mjs': 'import "../util/a.mjs";\nexport { x } from "../commands/b.mjs";\n',
    'src/via/z.mjs': 'export { x } from "../commands/b.mjs";\n',
    [dst]: 'export const x = 1;\n',
    'pyproject.toml': '[project]\nname = "fixture"\n',
    '.simt/profiles/house.md': '---\nsimt-id: house\nsimt-title: House\nsimt-applies: [python]\nsimt-priority: hard\n---\n\n' + marker.body,
  });
  assert.deepEqual(await runDeclaredChecks(root, [marker], { architecture: { forbid: [forbid] } }), []);
  await writeFile(join(root, 'simt.json'), JSON.stringify({ architecture: { forbid: [{ ...forbid, transitive: true }] } }));
  const { ok, findings } = await checkRepo(root);
  assert.equal(ok, false);
  const [hit, ...others] = findings.filter((row) => row.status === 'import-direction-violation');
  assert.deepEqual(others, []);
  assert.deepEqual(hit.witness, [src, 'src/via/a.mjs', dst]);
  assert.equal(hit.line, 2);
  assert.equal(hit.specifier, '../via/a.mjs');
  assert.match(hit.detail, /keep utilities independent/);
});
