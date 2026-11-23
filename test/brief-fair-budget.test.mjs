import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { assembleBrief } from '../src/brief/assemble.mjs';
import { buildCompactPacket } from '../src/brief/render.mjs';
import { packSubmodular } from '../src/brief/submodular.mjs';
import { reindex } from '../src/index/store.mjs';
import { ensureGit, tempDir } from './fixture.mjs';

test('sub-linear byte pricing prevents 22-byte boilerplate from crowding out 95-byte FILES lines', () => {
  const items = [];
  for (let i = 1; i <= 10; i += 1) {
    items.push({ id: `note:${i}`, section: 'ADVICE', text: 'short boilerplate note', bytes: 22, relevance: [{ subtask: 1, score: 0.25 }] });
  }
  items.push({ id: 'file:1', section: 'FILES', text: 'src/auth.mjs authenticate refreshToken', bytes: 95, relevance: [{ subtask: 1, score: 1.0 }] });
  const packed = packSubmodular(items, { budget: 140 });
  assert.ok(packed.kept.includes('file:1'));
  assert.ok(packed.bytes <= 140);
});

test('Phase-1 round-robin subtask floor covers every subtask FILES line before taking a 2nd item for subtask 1', () => {
  const items = [
    { id: 'f1:a', section: 'FILES', text: 'src/a.mjs', bytes: 80, relevance: [{ subtask: 1, score: 1.0 }] },
    { id: 'f1:b', section: 'FILES', text: 'src/a2.mjs', bytes: 80, relevance: [{ subtask: 1, score: 0.9 }] },
    { id: 'f2:a', section: 'FILES', text: 'src/b.mjs', bytes: 80, relevance: [{ subtask: 2, score: 0.8 }] },
    { id: 'f3:a', section: 'FILES', text: 'src/c.mjs', bytes: 80, relevance: [{ subtask: 3, score: 0.7 }] },
  ];
  const packed = packSubmodular(items, { budget: 250 });
  assert.deepEqual(packed.kept, ['f1:a', 'f2:a', 'f3:a']);
  assert.ok(packed.bytes <= 250);
});

test('exact incremental byte accounting does not reserve headers for empty sections', () => {
  const items = [
    { id: 'f1', section: 'FILES', text: 'src/one.mjs', priority: 'hard', relevance: [{ subtask: 1, score: 1 }] },
    { id: 'f2', section: 'FILES', text: 'src/two.mjs', relevance: [{ subtask: 1, score: 1 }] },
    { id: 'd1', section: 'DECISIONS', text: 'ADR-001 ' + 'x'.repeat(200), relevance: [{ subtask: 1, score: 0.1 }] },
    { id: 's1', section: 'SKILLS', text: 'skill ' + 'y'.repeat(200), relevance: [{ subtask: 1, score: 0.1 }] },
  ];
  const result = buildCompactPacket(items, { budget: 70 });
  assert.ok(result.after <= 70);
  assert.ok(result.text.includes('src/two.mjs'));
});

test('8-subtask composite uses compressed SUBTASKS summary and covers all 8 subtasks inside 2,048 B', async () => {
  const root = await tempDir('brief-fair-8-');
  const names = ['auth', 'billing', 'cache', 'deploy', 'events', 'flags', 'graph', 'health'];
  const files = { 'simt.json': '{"brief":{"retrieval":"v2"}}' };
  for (const name of names) {
    files[`src/${name}.mjs`] = `export function handle${name}() { return '${name}'; }\n`;
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await ensureGit(root);
  await reindex(root, { fielded: true });

  const task = names.map((name) => `update ${name} module`).join(', and ');
  const result = await assembleBrief({ root, task, retrieval: 'v2', budget: 2048 });
  assert.equal(result.composite.subtasks.length, 8);
  assert.ok(result.packed.after <= 2048);
  assert.ok(result.sections.SUBTASKS[0].includes('T1..T8'));
  const coverage = result.composite.subtaskCoverage;
  const minFilesKept = Math.min(...coverage.map((c) => c.facets.FILES?.kept ?? 0));
  assert.equal(minFilesKept, 1, `all 8 subtasks covered inside 2048 B: ${JSON.stringify(coverage)}`);
});
