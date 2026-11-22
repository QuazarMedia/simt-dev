import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { resolveEntityAnchors, searchEntityCandidates } from '../src/index/entities.mjs';
import { readFieldedFts, readGraph, reindex } from '../src/index/store.mjs';
import { ensureGit, tempDir } from './fixture.mjs';

test('resolves exact paths, unique suffixes and directory-qualified ambiguous basenames', () => {
  const files = ['src/index/map.mjs', 'src/core/index.mjs', 'src/connectors/index.mjs', 'docs/München notes.md'];
  assert.deepEqual([...resolveEntityAnchors('Fix map.mjs', { files })], [
    ['src/index/map.mjs', [{ kind: 'suffix', query: 'map.mjs', matched: 'src/index/map.mjs' }]],
  ]);
  assert.deepEqual([...resolveEntityAnchors('Fix ./src/core/index.mjs', { files }).keys()], ['src/core/index.mjs']);
  assert.equal(resolveEntityAnchors('Fix index.mjs', { files }).size, 0);
  assert.deepEqual([...resolveEntityAnchors('Fix the connectors index.mjs', { files }).keys()], ['src/connectors/index.mjs']);
  assert.deepEqual([...resolveEntityAnchors('Edit "docs/munchen notes.md"', { files }).keys()], ['docs/München notes.md']);
  assert.equal(resolveEntityAnchors('Find remap.mjs', { files }).size, 0);
});

test('matches qualified names and whole symbols without substring or ambiguous matches', () => {
  const symbols = [
    { path: 'src/auth.mjs', name: 'rotate', qualname: 'AuthMiddleware.rotate' },
    { path: 'src/widgets.mjs', name: 'rotate', qualname: 'Widget::rotate' },
    { path: 'src/index/map.mjs', name: 'rankFiles' },
  ];
  assert.deepEqual([...resolveEntityAnchors('Fix AuthMiddleware.rotate and rankFiles()', { symbols })], [
    ['src/auth.mjs', [{ kind: 'qualified-symbol', query: 'AuthMiddleware.rotate', matched: 'AuthMiddleware.rotate' }]],
    ['src/index/map.mjs', [{ kind: 'symbol', query: 'rankFiles', matched: 'rankFiles' }]],
  ]);
  assert.deepEqual([...resolveEntityAnchors('Fix Widget::rotate', { symbols }).keys()], ['src/widgets.mjs']);
  assert.equal(resolveEntityAnchors('Fix rotate', { symbols }).size, 0);
  assert.equal(resolveEntityAnchors('Fix rankFilesDeep', { symbols }).size, 0);
});

async function fixture() {
  const root = await tempDir('index-entities-');
  const files = {
    'src/index/map.mjs': 'export function rankFiles() { return []; }\n',
    'src/primary.mjs': '// refresh token rotation\nexport const primary = 1;\n',
    'src/scattered.mjs': `// refresh\n${'// filler line\n'.repeat(390)}// token\n${'// filler line\n'.repeat(20)}// rotation\n`,
    'src/section.mjs': `${'// line of filler words\n'.repeat(600)}// journal\n`,
    'src/near.mjs': '// red one two three four five six seven eight blue\n',
    'src/far.mjs': '// red one two three four five six seven eight nine blue\n',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await ensureGit(root);
  await reindex(root, { fielded: true });
  return root;
}

test('native and overlay rankings agree on tiers, proximity and explainable components', async () => {
  const root = await fixture();
  const graph = await readGraph(root);
  const fts = await readFieldedFts(root);
  for (const task of ['Fix map.mjs', 'rankFiles()', 'refresh token rotation', 'journal', 'red blue']) {
    const native = await searchEntityCandidates(root, task);
    const overlay = await searchEntityCandidates(root, task, {
      files: [...graph.files].reverse(), symbols: [...graph.symbols].reverse(), fts: [...fts].reverse(),
    });
    assert.equal(native.error, null);
    assert.deepEqual(native, overlay, task);
    const top = native.candidates[0];
    assert.ok(top, task);
    for (const item of native.candidates) {
      assert.equal(item.score, Object.values(item.components).reduce((sum, value) => sum + value, 0));
    }
  }
  const files = (await searchEntityCandidates(root, 'Fix map.mjs')).candidates;
  assert.equal(files[0].path, 'src/index/map.mjs');
  assert.equal(files[0].tier, 1);
  const symbols = (await searchEntityCandidates(root, 'rankFiles()')).candidates;
  assert.equal(symbols[0].tier, 2);
  const phrase = (await searchEntityCandidates(root, 'refresh token rotation')).candidates;
  assert.equal(phrase[0].path, 'src/primary.mjs');
  assert.deepEqual(phrase[0].phrase, [['refresh', 'token'], ['token', 'rotation']]);
  assert.equal(phrase[0].tier, 3);
  assert.equal(phrase.find(({ path }) => path === 'src/scattered.mjs').components.proximity, 0);
  const section = (await searchEntityCandidates(root, 'journal')).candidates;
  assert.deepEqual(section.map(({ path, tier }) => [path, tier]), [['src/section.mjs', 4]]);
  const near = (await searchEntityCandidates(root, 'red blue')).candidates;
  assert.deepEqual(near.map(({ path, tier }) => [path, tier]), [['src/near.mjs', 3], ['src/far.mjs', 4]]);
});
