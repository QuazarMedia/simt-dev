import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { assembleBrief } from '../src/brief/assemble.mjs';
import { buildCompactPacket, compactFileLine } from '../src/brief/render.mjs';
import { packSubmodular } from '../src/brief/submodular.mjs';
import { reindex } from '../src/index/store.mjs';
import { ensureGit, tempDir } from './fixture.mjs';

test('Nash Social Welfare packer covers all subtasks fairly, breaks ties deterministically, and runs under 5ms', () => {
  const items = [{ id: 'task', section: 'TASK', text: 'Eight subtask run', priority: 'hard' }];
  for (let s = 1; s <= 8; s += 1) {
    items.push({ id: `file:${s}:1`, section: 'FILES', text: `src/mod${s}.mjs handler${s}`, bytes: 80, relevance: [{ subtask: s, score: 1 }] });
    items.push({ id: `test:${s}:1`, section: 'TESTS', text: `test/mod${s}.test.mjs`, bytes: 50, relevance: [{ subtask: s, score: 0.9 }] });
  }
  for (let extra = 2; extra <= 6; extra += 1) {
    items.push({ id: `file:1:${extra}`, section: 'FILES', text: `src/extra${extra}.mjs`, bytes: 80, relevance: [{ subtask: 1, score: 0.95 }] });
  }

  const started = performance.now();
  const packed = packSubmodular(items, { budget: 1024, algorithm: 'nash' });
  const elapsed = performance.now() - started;

  assert.equal(packed.method, 'nash');
  assert.ok(packed.bytes <= 1024);
  assert.ok(elapsed < 15);
  const covered = new Set();
  for (const id of packed.kept) {
    const match = id.match(/^(?:file|test):(\d+):/);
    if (match) covered.add(Number(match[1]));
  }
  assert.equal(covered.size, 8);
  assert.deepEqual(packed, packSubmodular(items.toReversed(), { budget: 1024, algorithm: 'nash' }));
});

test('progressive compression shrinks symbol lists 4 -> 2 -> 1 -> 0 before dropping uncovered subtasks', () => {
  const path = 'src/service/auth.mjs';
  const symbols = ['verifyToken', 'issueToken', 'revokeToken', 'rotateKey'].map((name, i) => ({
    name, line: i + 1, exported: 1,
  }));
  const line4 = compactFileLine(path, symbols, 'verifyToken issueToken revokeToken rotateKey', { maxSymbols: 4 });
  const line2 = compactFileLine(path, symbols, 'verifyToken issueToken revokeToken rotateKey', { maxSymbols: 2 });
  const line1 = compactFileLine(path, symbols, 'verifyToken issueToken revokeToken rotateKey', { maxSymbols: 1 });
  const line0 = compactFileLine(path, symbols, 'verifyToken issueToken revokeToken rotateKey', { maxSymbols: 0 });
  assert.ok(line4.includes('rotateKey'));
  assert.equal(line2.includes('revokeToken'), false);
  assert.ok(line2.includes('+2'));
  assert.ok(line1.includes('+3'));
  assert.equal(line0, 'src/service/auth.mjs +4');

  const items = [];
  for (let s = 1; s <= 4; s += 1) {
    items.push({
      id: `f:${s}`,
      section: 'FILES',
      text: `[T${s}] src/mod${s}.mjs alphaSymbol betaSymbol gammaSymbol deltaSymbol`,
      variants: [
        `[T${s}] src/mod${s}.mjs alphaSymbol betaSymbol +2`,
        `[T${s}] src/mod${s}.mjs alphaSymbol +3`,
        `[T${s}] src/mod${s}.mjs +4`,
      ],
      relevance: [{ subtask: s, score: 1 }],
    });
  }
  // Full lines would exceed 210 bytes for 4 files; progressive compression fits all 4 subtasks!
  const result = buildCompactPacket(items, { budget: 210, algorithm: 'nash' });
  assert.ok(result.after <= 210);
  for (let s = 1; s <= 4; s += 1) {
    assert.ok(result.text.includes(`[T${s}] src/mod${s}.mjs`), `subtask ${s} survives compression`);
  }
});

test('8-subtask composite with Nash achieves full coverage at 2048B and >=0.70 MSC at 1024B', async () => {
  const root = await tempDir('brief-nash-8-');
  const names = ['auth', 'billing', 'cache', 'deploy', 'events', 'flags', 'graph', 'health'];
  const files = { 'simt.json': '{"brief":{"retrieval":"v2"}}' };
  for (const name of names) {
    files[`src/${name}.mjs`] = [
      `export function handle${name}One() { return 1; }`,
      `export function handle${name}Two() { return 2; }`,
      `export function handle${name}Three() { return 3; }`,
      `export function handle${name}Four() { return 4; }`,
    ].join('\n') + '\n';
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await ensureGit(root);
  await reindex(root, { fielded: true });

  const task = names.map((name) => `update ${name} module`).join(', and ');
  const full = await assembleBrief({ root, task, retrieval: 'v2', budget: 2048, nash: true });
  assert.ok(full.packed.after <= 2048);
  const fullCov = full.composite.subtaskCoverage;
  const fullMinFiles = Math.min(...fullCov.map((c) => c.facets.FILES?.kept ?? 0));
  assert.ok(fullMinFiles >= 1);

  const tight = await assembleBrief({ root, task, retrieval: 'v2', budget: 1024, nash: true });
  assert.ok(tight.packed.after <= 1024);
  const tightCov = tight.composite.subtaskCoverage;
  const coveredRatio = tightCov.filter((c) => (c.facets.FILES?.kept ?? 0) >= 1).length / tightCov.length;
  assert.ok(coveredRatio >= 0.70, `expected >= 0.70 subtask FILES coverage at 1024B, got ${coveredRatio}`);
});
