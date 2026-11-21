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

import { git, capture } from './fixture.mjs';
import {
  DAMPING,
  EMBED_RECALL_GAIN_BAR,
  ITERATIONS,
  RRF_K,
  goldPaths,
  measureRecall,
  rankFiles,
  recallAt10,
  renderMap,
  rrfFuse,
} from '../src/index/map.mjs';
import { cosineSimilarity, rankByCosine } from '../src/index/vectors.mjs';
import { loadGraph, mapCommand } from '../src/commands/map.mjs';
import { SQLITE_FILE } from '../src/index/persist.mjs';
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

test('loadGraph without build names a broken index instead of serving it as cold (Q44)', async () => {
  // A present index that cannot be read is `broken`, not `cold`: the caller
  // reports a damaged index instead of answering "nothing here".
  const root = await mkdtemp(join(tmpdir(), 'idx-map-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 1;\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    await reindex(root);
    const indexFile = join(root, SQLITE_FILE);
    await writeFile(indexFile, 'not an index');
    const broken = await loadGraph(root, { build: false });
    assert.equal(broken.broken, true, 'the damaged index is named');
    assert.equal(broken.files.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test('a path the task spells is the answer, not one candidate among word overlaps', () => {
  const ranked = rankFiles({
    files: [{ path: 'src/commands/why.mjs' }, { path: 'src/testing/paths.mjs' }],
    edges: [],
    symbols: [
      { path: 'src/commands/why.mjs', name: 'whyCommand', exported: 1 },
      { path: 'src/testing/paths.mjs', name: 'isTestPath', exported: 1 },
    ],
    task: 'fix the path resolution in src/commands/why.mjs',
  });
  assert.equal(ranked[0].path, 'src/commands/why.mjs');
  assert.equal(
    ranked.some((row) => row.path === 'src/testing/paths.mjs'),
    false,
    'a word overlap is not a candidate when the task names a path',
  );
});

test('a task word reaches the file through a plural directory and a camel case symbol', () => {
  // `packs` is `pack` and `migratePack` is `migrate`: the two spellings the resolver used
  // to miss, which let the import hub outrank the file the task was actually about.
  const camel = rankFiles({
    files: [{ path: 'src/migrations/manage.mjs' }, { path: 'src/name.mjs' }],
    edges: [{ src: 'src/migrations/manage.mjs', dst: 'src/name.mjs', kind: 'import', weight: 1 }],
    symbols: [
      { path: 'src/migrations/manage.mjs', name: 'migratePack', exported: 1 },
      { path: 'src/name.mjs', name: 'CLI', exported: 1 },
    ],
    task: 'migrate the pack',
  });
  assert.equal(camel[0].path, 'src/migrations/manage.mjs');
  assert.equal(camel.find((row) => row.path === 'src/name.mjs').resolver, 0, 'the hub is not a match');

  const plural = rankFiles({
    files: [{ path: 'src/packs.mjs' }, { path: 'src/name.mjs' }],
    edges: [{ src: 'src/packs.mjs', dst: 'src/name.mjs', kind: 'import', weight: 1 }],
    symbols: [{ path: 'src/name.mjs', name: 'CLI', exported: 1 }],
    task: 'add a pack flag',
  });
  assert.equal(plural[0].path, 'src/packs.mjs');
  assert.ok(plural.find((row) => row.path === 'src/packs.mjs').resolver > 0);
});

test('a camel-case symbol resolves its file from the symbol name or a word inside it', () => {
  // `readBench` is the only thing the file holds. The exact spelling matches the symbol;
  // `bench` does not, and tokenize does not split camel case, so only the camel-case rule
  // can put the file in the resolver list for that task.
  const input = {
    files: [{ path: 'src/packs/manage.mjs' }, { path: 'src/name.mjs' }],
    edges: [{ src: 'src/packs/manage.mjs', dst: 'src/name.mjs', kind: 'import', weight: 1 }],
    symbols: [
      { path: 'src/packs/manage.mjs', name: 'readBench', exported: 1 },
      { path: 'src/name.mjs', name: 'CLI', exported: 1 },
    ],
  };
  const exact = rankFiles({ ...input, task: 'readBench' });
  assert.ok(exact.find((row) => row.path === 'src/packs/manage.mjs').resolver > 0, 'the symbol name resolves its file');
  assert.equal(exact.find((row) => row.path === 'src/name.mjs').resolver, 0, 'the hub is not a match');

  const inside = rankFiles({ ...input, task: 'bench' });
  assert.ok(
    inside.find((row) => row.path === 'src/packs/manage.mjs').resolver > 0,
    'a word inside the camel-case symbol is evidence',
  );
  assert.equal(inside.find((row) => row.path === 'src/name.mjs').resolver, 0);
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
  await reindex(root);

  const ranked = await capture(() => mapCommand([], { root, task: 'change greet in src/keep.mjs', budget: '0' }));
  assert.equal(ranked.code, 0);
  assert.match(ranked.stdout, /src\/keep\.mjs/);
  const again = await capture(() => mapCommand([], { root, task: 'change greet in src/keep.mjs', budget: '0' }));
  assert.equal(again.stdout, ranked.stdout);

  // The JSON files are the rendered rows, not the resolver's rows: `resolver` is an
  // internal score for filtering, and a fourth field here would be public API.
  const json = await capture(() => mapCommand([], { root, task: 'change greet in src/keep.mjs', budget: '0', json: true }));
  assert.equal(json.code, 0);
  const payload = JSON.parse(json.stdout);
  assert.ok(payload.files.length > 0);
  for (const row of payload.files) {
    assert.deepEqual(Object.keys(row).sort(), ['path', 'rank'], JSON.stringify(row));
  }

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
  const measured = await measureRecall(root, { vaultRoot: vault });
  assert.equal(measured.measured, true);
  assert.ok(measured.recall >= 0.6, `recall ${measured.recall}`);

  const bare = await mkdtemp(join(tmpdir(), 'idx-map-'));
  const refused = await capture(() => mapCommand([], { root: bare }));
  assert.equal(refused.code, 5);
  await rm(root, { recursive: true, force: true });
  await rm(bare, { recursive: true, force: true });
});

test('map says when the ranking is the graph hub rather than a match (Q52)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-nomatch-'));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'keep.mjs'), 'export function greet() {}\n');
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);

  const hub = await capture(() => mapCommand([], { root, task: 'zebracorn', budget: '0' }));
  assert.equal(hub.code, 0);
  assert.match(hub.stdout, /basis\s+unmatched/);
  assert.match(hub.stdout, /no path or symbol matches this task's words/);
  const hubJson = await capture(() => mapCommand([], { root, task: 'zebracorn', budget: '0', json: true }));
  assert.equal(JSON.parse(hubJson.stdout).matched, 0, 'the hub is not a path or symbol match');

  const matched = await capture(() => mapCommand([], { root, task: 'change greet in src/keep.mjs', budget: '0' }));
  assert.match(matched.stdout, /basis\s+matched/);

  // No task is not a miss either: nothing was asked, so nothing is claimed.
  const bare = await capture(() => mapCommand([], { root, budget: '0' }));
  assert.match(bare.stdout, /basis\s+no-task/);
  await rm(root, { recursive: true, force: true });
});

test('a body-only hit is context, not a match', async () => {
  // BM25 ranks the token because it is in the body; no path or symbol mentions it. The
  // fused score is positive and a fused-score count used to report this as matched.
  const root = await mkdtemp(join(tmpdir(), 'idx-body-'));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'keep.mjs'), 'export function greet() {}\n// zebracorn\n');
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);

  const body = await capture(() => mapCommand([], { root, task: 'zebracorn', budget: '0', json: true }));
  assert.equal(body.code, 0);
  const payload = JSON.parse(body.stdout);
  assert.equal(payload.matched, 0, 'a body hit is not a path or symbol match');
  assert.ok(payload.files.length > 0, 'the BM25 rows are still offered as context');
  assert.equal(payload.basis, 'unmatched', 'the basis names the absence of a resolver match, not a cause');

  const human = await capture(() => mapCommand([], { root, task: 'zebracorn', budget: '0' }));
  assert.equal(human.code, 0);
  assert.match(human.stdout, /basis\s+unmatched/);
  assert.match(
    human.stdout,
    /no path or symbol matches this task's words; the ranking is context, not a match/,
    'the human output did not explain that the body hit is context',
  );
  await rm(root, { recursive: true, force: true });
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
  await reindex(root);

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

  await reindex(root);
  const ftsRows = await readFts(root);
  assert.equal(ftsRows.length, 3);
  const bm25Hits = await searchFtsBm25(root, 'fix xdgConfigHome lookup');
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
  const embeddedIdx = await reindex(root, { embed: true, fetchImpl: stubFetch });
  assert.equal(embeddedIdx.embedState, 'embedded');
  assert.equal(embeddedIdx.embeddings, 13);
  // The data basis is recorded with the rows: model, endpoint, sizes - and no content.
  assert.equal(embeddedIdx.embedBasis.model, 'nomic-embed-code');
  assert.ok(embeddedIdx.embedBasis.requestBytes > 0 && embeddedIdx.embedBasis.responseBytes > 0);
  assert.ok(!JSON.stringify(embeddedIdx.embedBasis).includes('semantic target'));
  const storedVecs = await readEmbeddings(root);
  assert.equal(storedVecs.length, 13);
  const cachedIdx = await reindex(root, {
    embed: true,
    fetchImpl: () => {
      throw new Error('cached embeddings must not re-fetch unchanged blobs');
    },
  });
  assert.equal(cachedIdx.embedState, 'cached');
  assert.equal(cachedIdx.embedBasis, null, 'a cached build made no exchange to describe');

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
  const withoutEmbed = await measureRecall(root, { vaultRoot: vault });
  assert.equal(withoutEmbed.baseRecall, 0);
  assert.equal(withoutEmbed.embeddingsDefault, 'off');

  // With embeddings that align `t-sem` with `src/mod11.mjs`, recall rises from 0.0 to 1.0 (+100 pts >= +10 pts).
  const withHelpfulEmbed = await measureRecall(root, {
    vaultRoot: vault,
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
    embeddings: storedVecs,
    taskVectors: { 't-sem': [1, 0, 0, 0] },
  });
  assert.equal(withFlatEmbed.embedDelta, 0);
  assert.equal(withFlatEmbed.embedAccepted, false);
  assert.equal(withFlatEmbed.embeddingsDefault, 'off');

  await rm(root, { recursive: true, force: true });
});

