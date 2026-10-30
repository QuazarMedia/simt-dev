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
import {
  DAMPING,
  EMBED_RECALL_GAIN_BAR,
  ITERATIONS,
  RRF_K,
  cosineSimilarity,
  goldPaths,
  measureRecall,
  rankByCosine,
  rankFiles,
  recallAt10,
  renderMap,
  rrfFuse,
} from '../src/index/map.mjs';
import { loadGraph, mapCommand } from '../src/commands/map.mjs';
import {
  buildFtsBody,
  decodeVectorBlob,
  encodeVectorBlob,
  ftsKindOf,
  ftsQueryTerms,
  readEmbeddings,
  readFts,
  reindex,
  searchFtsBm25,
} from '../src/index/store.mjs';

const FILES = [
  { path: 'src/keep.mjs' },
  { path: 'src/other.mjs' },
  { path: 'src/alone.mjs' },
];

test('loadGraph without build reports a stale index instead of hiding it (Q42)', async () => {
  // The prompt hook and the MCP surface may not build; what they may do is
  // distrust. The stale rows are still served (a cache is a cache), labelled.
  const root = await mkdtemp(join(tmpdir(), 'idx-map-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 1;\n');
    await writeFile(join(root, 'src', 'gone.mjs'), 'export const gone = 1;\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    await reindex(root);
    const fresh = await loadGraph(root, { build: false });
    assert.equal(fresh.cold, undefined);
    assert.equal(fresh.stale, false);
    await git(['-C', root, 'rm', '-q', 'src/gone.mjs']);
    await git(['-C', root, 'commit', '-qm', 'drop gone']);
    const old = await loadGraph(root, { build: false });
    assert.equal(old.stale, true);
    assert.ok(old.files.some((f) => f.path === 'src/gone.mjs'), 'stale rows are served, labelled');
    const rebuilt = await loadGraph(root);
    assert.equal(rebuilt.stale, false, 'a build vouches for the tree it just read');
    assert.equal(rebuilt.files.some((f) => f.path === 'src/gone.mjs'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

  await mkdir(join(root, '.simt', 'bench', 'tasks'), { recursive: true });
  await writeFile(
    join(root, '.simt', 'bench', 'tasks', 't.json'),
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

test('a file added after the build is visible to map without a manual index (ADR-108)', async () => {
  // The cache is refreshed from the git index on every read: a blob that has not
  // changed is not re-read, so the cost of a current repository is one `git ls-files`,
  // and a file staged after the last build is in the next map.
  const root = await mkdtemp(join(tmpdir(), 'idx-refresh-'));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'keep.mjs'), 'export function greet() {}\n');
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  await reindex(root, { backend: 'jsonl' });

  // The build is done; a file that lands afterwards is not in the cache yet.
  await writeFile(join(root, 'src', 'late.mjs'), 'export const late = 1;\n');
  await git(['-C', root, 'add', '-A']);

  const mapped = await capture(() => mapCommand([], { root, task: 'change late in src/late.mjs', budget: '0' }));
  assert.equal(mapped.code, 0);
  assert.match(mapped.stdout, /src\/late\.mjs/, 'the file staged after the build is not in the map');
  await rm(root, { recursive: true, force: true });
});

test('R28: hybrid retrieval fuses FTS5 bm25, graph proximity and resolver signals deterministically', async () => {
  assert.equal(RRF_K, 40);
  assert.equal(EMBED_RECALL_GAIN_BAR, 0.1);
  assert.equal(ftsKindOf('docs/decisions/ADR-001.md', ''), 'decisions');
  assert.equal(ftsKindOf('docs/lessons/0001-x.md', ''), 'lessons');
  assert.equal(ftsKindOf('graph/skills.graph.json', ''), 'skills');
  assert.equal(ftsKindOf('src/a.mjs', 'javascript'), 'code');
  assert.equal(ftsKindOf('README.md', ''), 'docs');
  assert.ok(buildFtsBody('src/a.mjs', [{ name: 'computeChecksum', sig: 'export function computeChecksum()' }], 'const magicToken = 42;').includes('magictoken'));
  assert.deepEqual(ftsQueryTerms('Fix the magicToken checksum in this file'), ['fix', 'magictoken', 'checksum']);

  const fused = rrfFuse([
    { items: ['src/b.mjs', 'src/a.mjs'], weight: 1 },
    { items: ['src/a.mjs', 'src/c.mjs'], weight: 2 },
  ]);
  assert.equal(fused[0].path, 'src/a.mjs');

  const root = await mkdtemp(join(tmpdir(), 'idx-hybrid-'));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'alpha.mjs'), 'export function parseHeader() {\n  const xdgConfigHome = 1;\n  return xdgConfigHome;\n}\n');
  await writeFile(join(root, 'src', 'beta.mjs'), 'export function formatOutput() {\n  return "ok";\n}\n');
  await writeFile(join(root, 'README.md'), '# Project overview\n');
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);

  await reindex(root, { backend: 'sqlite' });
  const ftsRows = await readFts(root, { backend: 'sqlite' });
  assert.equal(ftsRows.length, 3);
  const bm25Hits = await searchFtsBm25(root, 'fix xdgConfigHome lookup', { backend: 'sqlite' });
  assert.ok(bm25Hits.length >= 1);
  assert.equal(bm25Hits[0].path, 'src/alpha.mjs');

  // Even when the task mentions neither path ("alpha") nor exported symbol ("parseHeader"),
  // FTS5 bm25 surfaces src/alpha.mjs via its body token `xdgConfigHome`.
  const mapped = await capture(() => mapCommand([], { root, task: 'fix xdgConfigHome lookup', budget: '0' }));
  assert.equal(mapped.code, 0);
  assert.match(mapped.stdout, /src\/alpha\.mjs/);
  await rm(root, { recursive: true, force: true });
});

test('R28: SQLite vector blobs, brute-force cosine similarity, and +10-point recall@10 gate keep embeddings off by default', async () => {
  const vec = [0.25, -0.5, 0.75, 1.0];
  const blob = encodeVectorBlob(vec);
  const decoded = decodeVectorBlob(blob);
  assert.equal(decoded.length, 4);
  assert.ok(Math.abs(decoded[0] - 0.25) < 1e-6);
  assert.ok(Math.abs(cosineSimilarity(decoded, [0.25, -0.5, 0.75, 1.0]) - 1.0) < 1e-6);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);

  const cosRanked = rankByCosine(
    [
      { path: 'src/far.mjs', vec: encodeVectorBlob([1, 0, 0]) },
      { path: 'src/near.mjs', vec: encodeVectorBlob([0, 1, 0]) },
    ],
    [0.1, 0.99, 0],
  );
  assert.equal(cosRanked[0].path, 'src/near.mjs');

  const root = await mkdtemp(join(tmpdir(), 'idx-embed-'));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'src'), { recursive: true });
  for (let i = 0; i < 12; i += 1) {
    const p = `src/mod${String(i).padStart(2, '0')}.mjs`;
    await writeFile(join(root, p), `export function fn${i}() { return ${i}; }\n`);
  }
  await writeFile(
    join(root, 'simt.json'),
    `${JSON.stringify({ local: { embed: { url: 'http://127.0.0.1:11434/v1', model: 'nomic-embed-code' } } }, null, 2)}\n`,
  );
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);

  // 1. Default reindex keeps embeddings off and opens no socket even when local.embed is configured.
  const defaultIdx = await reindex(root, {
    backend: 'sqlite',
    fetchImpl: () => {
      throw new Error('default reindex must not call embed endpoint');
    },
  });
  assert.equal(defaultIdx.embedState, 'off');
  assert.equal(defaultIdx.embeddings, 0);

  // 2. Explicit `embed: true` stores vectors as SQLite blobs and caches unchanged blobs.
  const stubFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const data = inputs.map((text, index) => ({
      index,
      embedding: String(text).includes('mod11') || String(text).includes('semantic target')
        ? [0, 0, 1, 0]
        : [1, 0, 0, 0],
    }));
    return new Response(JSON.stringify({ model: 'nomic-embed-code', data }), { status: 200 });
  };
  const embeddedIdx = await reindex(root, { backend: 'sqlite', embed: true, fetchImpl: stubFetch });
  assert.equal(embeddedIdx.embedState, 'embedded');
  assert.equal(embeddedIdx.embeddings, 13);
  const storedVecs = await readEmbeddings(root, { backend: 'sqlite' });
  assert.equal(storedVecs.length, 13);
  const cachedIdx = await reindex(root, {
    backend: 'sqlite',
    embed: true,
    fetchImpl: () => {
      throw new Error('cached embeddings must not re-fetch unchanged blobs');
    },
  });
  assert.equal(cachedIdx.embedState, 'cached');

  // 3. Evaluate recall@10 gate: embeddings are accepted only when they raise recall@10 by >= 10 points.
  await mkdir(join(root, '.simt', 'bench', 'tasks'), { recursive: true });
  await writeFile(
    join(root, '.simt', 'bench', 'tasks', 't-sem.json'),
    JSON.stringify({ id: 't-sem', prompt: 'adjust semantic target behaviour' }),
  );
  const vault = join(root, 'vault');
  await mkdir(join(vault, 't-sem'), { recursive: true });
  await writeFile(join(vault, 't-sem', 'gold.patch'), 'diff --git a/src/mod11.mjs b/src/mod11.mjs\n');

  // Without embeddings, `src/mod11.mjs` is 12th alphabetically (outside top 10 -> recall 0).
  const withoutEmbed = await measureRecall(root, { vaultRoot: vault, backend: 'sqlite' });
  assert.equal(withoutEmbed.baseRecall, 0);
  assert.equal(withoutEmbed.embeddingsDefault, 'off');

  // With embeddings that align `t-sem` with `src/mod11.mjs`, recall rises from 0.0 to 1.0 (+100 pts >= +10 pts).
  const withHelpfulEmbed = await measureRecall(root, {
    vaultRoot: vault,
    backend: 'sqlite',
    embed: true,
    fetchImpl: stubFetch,
  });
  assert.equal(withHelpfulEmbed.baseRecall, 0);
  assert.equal(withHelpfulEmbed.embedRecall, 1);
  assert.equal(withHelpfulEmbed.embedDelta, 1);
  assert.equal(withHelpfulEmbed.embedAccepted, true);

  // With unhelpful embeddings (+0 pts < +10 pts), embedAccepted is false and recall stays at baseRecall.
  const withFlatEmbed = await measureRecall(root, {
    vaultRoot: vault,
    backend: 'sqlite',
    embeddings: storedVecs,
    taskVectors: { 't-sem': [1, 0, 0, 0] },
  });
  assert.equal(withFlatEmbed.embedDelta, 0);
  assert.equal(withFlatEmbed.embedAccepted, false);
  assert.equal(withFlatEmbed.embeddingsDefault, 'off');

  await rm(root, { recursive: true, force: true });
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
