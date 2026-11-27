import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { assembleBrief } from '../src/brief/assemble.mjs';
import { compactScopedFileLine } from '../src/brief/render.mjs';
import { selectFileScopes } from '../src/brief/scopes.mjs';
import { reindex } from '../src/index/store.mjs';
import { ensureGit, tempDir } from './fixture.mjs';

test('selectFileScopes and compactScopedFileLine format >200-line scope spans within 95 bytes', () => {
  const scopes = [
    { symbol: 'helperOne', qualifiedName: 'helperOne', line: 10, endLine: 25 },
    { symbol: 'handleError', qualifiedName: 'handleError', line: 210, endLine: 258 },
  ];
  assert.deepEqual(selectFileScopes('src/small.mjs', { lines: 150, scopes }, 'fix handleError'), []);
  const picked = selectFileScopes('src/big.mjs', { lines: 280, scopes }, 'fix handleError');
  assert.deepEqual(picked, [{ name: 'handleError', startLine: 210, endLine: 258 }]);

  const line = compactScopedFileLine('src/big.mjs', picked, scopes.map((s) => ({ name: s.symbol, line: s.line, exported: 1 })), 'fix handleError', { subtasks: [1] });
  assert.ok(line.startsWith('[T1] src/big.mjs:210-258 handleError'));
  assert.ok(Buffer.byteLength(line) <= 95);
});

test('assembleBrief emits live overlay-updated line spans for >200-line files in composite and single-task briefs', async () => {
  const root = await tempDir('brief-scope-spans-');
  await mkdir(join(root, 'src'), { recursive: true });
  const padding = Array.from({ length: 205 }, (_, i) => `export const pad${i} = ${i};`).join('\n');
  const targetBody = [
    padding,
    'export function handleTokenError(err) {',
    '  if (!err) return null;',
    '  return String(err.message ?? err);',
    '}',
  ].join('\n') + '\n';
  await writeFile(join(root, 'src', 'large.mjs'), targetBody);
  await writeFile(join(root, 'src', 'small.mjs'), 'export function quickCheck(x) { return Boolean(x); }\n');
  await ensureGit(root);
  await reindex(root, { fielded: true });

  const composite = await assembleBrief({
    root,
    task: 'Fix handleTokenError bug and update quickCheck helper',
    retrieval: 'v2',
    scopeSpans: true,
    budget: 2048,
  });
  const largeLine = composite.sections.FILES.find((line) => line.includes('src/large.mjs'));
  const smallLine = composite.sections.FILES.find((line) => line.includes('src/small.mjs'));
  assert.match(largeLine, /src\/large\.mjs:206-208 handleTokenError/u);
  assert.equal(/src\/small\.mjs:\d+-\d+/u.test(smallLine), false);
  assert.deepEqual(composite.composite.scopes, [
    { path: 'src/large.mjs', name: 'handleTokenError', startLine: 206, endLine: 208 },
  ]);

  // Live worktree edit shifts handleTokenError down by 5 lines without reindexing!
  await writeFile(join(root, 'src', 'large.mjs'), '\n\n\n\n\n' + targetBody);
  const liveComposite = await assembleBrief({
    root,
    task: 'Fix handleTokenError bug and update quickCheck helper',
    retrieval: 'v2',
    scopeSpans: true,
    budget: 2048,
  });
  const liveLine = liveComposite.sections.FILES.find((line) => line.includes('src/large.mjs'));
  assert.match(liveLine, /src\/large\.mjs:211-213 handleTokenError/u);
  assert.deepEqual(liveComposite.composite.scopes, [
    { path: 'src/large.mjs', name: 'handleTokenError', startLine: 211, endLine: 213 },
  ]);

  // Single-task path also supports scopeSpans cleanly
  const single = await assembleBrief({
    root,
    task: 'Fix handleTokenError',
    retrieval: 'v2',
    scopeSpans: true,
    budget: 2048,
  });
  assert.ok(single.sections.FILES.some((line) => /src\/large\.mjs:211-213 handleTokenError/u.test(line)));
  assert.deepEqual(single.scopes, [
    { path: 'src/large.mjs', name: 'handleTokenError', startLine: 211, endLine: 213 },
  ]);
});
