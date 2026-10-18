// Ranked repo map (R22, ADR-091).
//
// The ranking is a function of the graph and the task text: fixed iterations,
// ties broken by path. recall@10 on a hand-built gold list is the metric the
// mined-task bar uses. The mined-task bar itself is measured outside this
// fixture, because the gold patches live in the vault and a test must not
// read one (ADR-031).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from './fixture.mjs';
import { DAMPING, ITERATIONS, goldPaths, measureRecall, rankFiles, recallAt10, renderMap } from '../src/index/map.mjs';
import { mapCommand } from '../src/commands/map.mjs';
import { reindex } from '../src/index/store.mjs';

const FILES = [
  { path: 'src/keep.mjs' },
  { path: 'src/other.mjs' },
  { path: 'src/alone.mjs' },
];

test('the same graph and the same task rank the same way, and a tie breaks by path', () => {
  assert.equal(ITERATIONS, 20);
  assert.equal(DAMPING, 0.85);
  const input = { files: FILES, edges: [], symbols: [], task: '' };
  const first = rankFiles(input);
  const second = rankFiles(input);
  assert.deepEqual(second, first);
  assert.deepEqual(first.map((row) => row.path), ['src/alone.mjs', 'src/keep.mjs', 'src/other.mjs']);
});

test('a file the task names outranks a file it does not, and a neighbour comes with it', () => {
  const ranked = rankFiles({
    files: FILES,
    edges: [{ src: 'src/keep.mjs', dst: 'src/other.mjs', kind: 'import', weight: 1 }],
    symbols: [
      { path: 'src/other.mjs', name: 'hidden', exported: 0 },
      { path: 'src/keep.mjs', name: 'greet', exported: 1 },
    ],
    task: 'change greet in src/keep.mjs',
  });
  assert.equal(ranked[0].path, 'src/keep.mjs');
  assert.deepEqual(ranked.map((row) => row.path).sort(), ['src/keep.mjs', 'src/other.mjs']);
  assert.ok(!ranked.some((row) => row.path === 'src/alone.mjs'));
});

test('outline, names and signatures stay inside the budget', () => {
  const ranked = rankFiles({
    files: [{ path: 'src/alpha.mjs' }, { path: 'src/beta.mjs' }],
    edges: [],
    symbols: [{ path: 'src/alpha.mjs', name: 'alpha', exported: 1, sig: 'export function alpha()', line: 1 }],
    task: '',
  });
  const outline = renderMap(ranked, [], { level: 'outline', budget: 14 });
  assert.equal(outline.shown, 1);
  assert.equal(outline.text, 'src/alpha.mjs');
  assert.equal(outline.truncated, true);
  const symbols = [{ path: 'src/alpha.mjs', name: 'alpha', exported: 1, sig: 'export function alpha()', line: 1 }];
  const names = renderMap(ranked, symbols, { level: 'names', budget: 0 });
  assert.match(names.text, /src\/alpha\.mjs alpha/);
  const signatures = renderMap(ranked, symbols, { level: 'signatures', budget: 0 });
  assert.match(signatures.text, /alpha export function alpha\(\)/);
});

test('recall@10 is the fraction of gold files in the top 10', () => {
  const ranked = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
  assert.equal(recallAt10(ranked, ['a', 'b', 'y', 'z']), 0.5);
  assert.equal(recallAt10(ranked, []), null);
  assert.deepEqual(goldPaths('diff --git a/src/a.mjs b/src/a.mjs\n'), ['src/a.mjs']);
});

test('simt map renders the ranking, and recall is unmeasured without a vault', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-map-'));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'keep.mjs'), 'export function greet() {}\nimport "./other.mjs";\n');
  await writeFile(join(root, 'src', 'other.mjs'), 'export const other = 1;\n');
  await writeFile(join(root, 'src', 'alone.mjs'), 'export const alone = 1;\n');
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  await reindex(root, { backend: 'jsonl' });

  const ranked = await capture(() => mapCommand([], { root, task: 'change greet in src/keep.mjs', budget: '0' }));
  assert.equal(ranked.code, 0);
  assert.match(ranked.stdout, /src\/keep\.mjs/);
  const again = await capture(() => mapCommand([], { root, task: 'change greet in src/keep.mjs', budget: '0' }));
  assert.equal(again.stdout, ranked.stdout);

  const unknown = await capture(() => mapCommand([], { root, level: 'prose' }));
  assert.equal(unknown.code, 2);

  const recalled = await capture(() => mapCommand([], { root, recall: true }));
  assert.equal(recalled.code, 0);
  assert.match(recalled.stdout, /unmeasured/);

  await mkdir(join(root, '.simt-dev', 'bench', 'tasks'), { recursive: true });
  await writeFile(
    join(root, '.simt-dev', 'bench', 'tasks', 't.json'),
    JSON.stringify({ id: 't-1', prompt: 'change greet in src/keep.mjs' }),
  );
  const vault = join(root, 'vault');
  await mkdir(join(vault, 't-1'), { recursive: true });
  await writeFile(join(vault, 't-1', 'gold.patch'), 'diff --git a/src/keep.mjs b/src/keep.mjs\n');
  const measured = await measureRecall(root, { vaultRoot: vault, backend: 'jsonl' });
  assert.equal(measured.measured, true);
  assert.ok(measured.recall >= 0.6, `recall ${measured.recall}`);

  const bare = await mkdtemp(join(tmpdir(), 'idx-map-'));
  const refused = await capture(() => mapCommand([], { root: bare }));
  assert.equal(refused.code, 5);
  await rm(root, { recursive: true, force: true });
  await rm(bare, { recursive: true, force: true });
});

async function capture(run) {
  const chunks = [];
  const errors = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    errors.push(String(chunk));
    return true;
  };
  try {
    const code = await run();
    return { code, stdout: chunks.join(''), stderr: errors.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}
