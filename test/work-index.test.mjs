// Plan 0004 W18: typed graph rows, a labelled working-tree overlay, and two backends that
// are one semantics.
//
// The index caches staged blobs, so it cannot answer for a file somebody is editing. The
// overlay is rows built from the working tree and merged over the staged rows at read time.
// The failures pinned here: an overlay digest spelled like a blob, a denied path that is
// read before it is filtered, a delete or rename that leaves the old rows behind, and two
// backends that disagree about what was stored.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OVERLAY_SCHEMA_VERSION,
  PROVENANCES,
  TRUST_LEVELS,
  buildOverlay,
  digestOf,
  filterAllowed,
  isStagedRevision,
  isWorktreeRevision,
  jsonlBackend,
  mergeOverlay,
  readEdge,
  readNode,
  revisionOf,
  sqliteBackend,
} from '../src/index/overlay.mjs';
import { keepTemp } from './fixture.mjs';

const worktreeNode = (path, text) =>
  readNode({
    key: `file:${path}`,
    kind: 'file',
    source: path,
    revision: revisionOf('working-tree', digestOf(text)),
    scope: null,
    provenance: 'working-tree',
    trust: 'observed',
  }).node;

const stagedNode = (path, blob) =>
  readNode({
    key: `file:${path}`,
    kind: 'file',
    source: path,
    revision: revisionOf('staged', blob),
    scope: null,
    provenance: 'staged',
    trust: 'observed',
  }).node;

async function tempFile(name) {
  const root = await mkdtemp(join(tmpdir(), 'simt-overlay-'));
  keepTemp(root);
  return join(root, name);
}

test('a row carries kind, revision, scope, provenance and trust, and a worktree digest cannot pass for a blob', () => {
  assert.equal(OVERLAY_SCHEMA_VERSION, 1);
  assert.deepEqual(PROVENANCES, ['staged', 'working-tree']);
  assert.deepEqual(TRUST_LEVELS, ['observed', 'proposed', 'reviewed']);

  const node = worktreeNode('docs/rates.md', '# rates\n');
  assert.equal(isWorktreeRevision(node.revision), true);
  assert.equal(isStagedRevision(node.revision), false);

  const forged = readNode({ ...node, provenance: 'staged' });
  assert.match(forged.problems.join('\n'), /revision must start with staged: for a staged row/, 'a worktree digest was accepted as staged');

  const unnamed = readNode({ ...node, trust: 'trusted' });
  assert.match(unnamed.problems.join('\n'), /trust must be one of observed, proposed, reviewed/);

  const edge = readEdge({ src: 'a.mjs', kind: 'imports', dst: 'b.mjs', revision: node.revision, provenance: 'working-tree', trust: 'proposed' }).edge;
  assert.equal(edge.weight, 1, 'an unstated weight is the default');
  assert.match(readEdge({ src: 'a.mjs', kind: 'imports', dst: 'b.mjs', revision: revisionOf('staged', 'abc'), provenance: 'working-tree', trust: 'observed' }).problems.join('\n'), /revision must start with worktree:/);
});

test('a denied path is filtered before it is read, so its contents never reach a row', async () => {
  const seen = [];
  const overlay = await buildOverlay({
    changes: [
      { path: 'docs/rates.md', status: 'modified' },
      { path: '.simt/index.sqlite', status: 'modified' },
      { path: 'secrets/token.txt', status: 'modified' },
      { path: 'node_modules/pkg/index.js', status: 'modified' },
    ],
    deny: ['secrets'],
    read: async (path) => {
      seen.push(path);
      return 'content';
    },
  });
  assert.deepEqual(seen, ['docs/rates.md'], 'a denied path was read');
  assert.deepEqual(overlay.denied, ['.simt/index.sqlite', 'node_modules/pkg/index.js', 'secrets/token.txt']);
  assert.deepEqual(overlay.nodes.map((node) => node.source), ['docs/rates.md']);
  assert.doesNotMatch(JSON.stringify({ nodes: overlay.nodes, edges: overlay.edges, unreadable: overlay.unreadable }), /token\.txt|index\.sqlite/, 'a denied path reached a row');

  assert.deepEqual(filterAllowed([{ path: 'a/.git' }, { path: '.git' }, { path: 'src/a.mjs' }]).denied, ['.git', 'a/.git']);
});

test('the overlay labels its own revision and reflects only the edits that are present', async () => {
  const read = async () => '# rates v1\n';
  const one = await buildOverlay({ changes: [{ path: 'docs/rates.md' }], read });
  const two = await buildOverlay({ changes: [{ path: 'docs/rates.md' }], read: async () => '# rates v2\n' });
  assert.match(one.revision, /^worktree:sha256-/);
  assert.notEqual(two.revision, one.revision, 'two contents share a revision');
  assert.equal(one.nodes[0].provenance, 'working-tree');
  assert.equal(one.nodes[0].trust, 'observed');

  const none = await buildOverlay({ changes: [], read });
  assert.deepEqual(none.nodes, []);
  assert.match(none.revision, /^worktree:/);

  const unreadable = await buildOverlay({ changes: [{ path: 'gone.md' }], read: async () => null });
  assert.deepEqual(unreadable.unreadable, ['gone.md']);
  assert.deepEqual(unreadable.nodes, [], 'an unreadable file produced a row with no content behind it');
});

test('a scope conflict is reported, not guessed, and an owned path names its scope', async () => {
  const scopes = [
    { id: 'de', paths: ['docs/*'] },
    { id: 'de-other', paths: ['docs/*'] },
  ];
  const conflicted = await buildOverlay({ changes: [{ path: 'docs/de/rates.md' }], scopes, read: async () => '# rates\n' });
  assert.equal(conflicted.nodes[0].scope, null);
  assert.match(conflicted.problems.join('\n'), /claimed by de and de-other/);

  const owned = await buildOverlay({ changes: [{ path: 'docs/de/rates.md' }], scopes: [{ id: 'de', paths: ['docs/de'] }], read: async () => '# rates\n' });
  assert.equal(owned.nodes[0].scope, 'de');
  assert.deepEqual(owned.problems, []);
});

test('a rename and a delete converge: the old key is tombstoned and every row it owned goes with it', async () => {
  const base = {
    nodes: [
      stagedNode('docs/rates.md', 'blob-a'),
      readNode({ key: 'sym:docs/rates.md#vat@1', kind: 'symbol', source: 'docs/rates.md', revision: revisionOf('staged', 'blob-a'), provenance: 'staged', trust: 'observed' }).node,
      stagedNode('docs/old.md', 'blob-b'),
      stagedNode('docs/kept.md', 'blob-c'),
    ],
    edges: [{ src: 'docs/rates.md', kind: 'imports', dst: 'docs/kept.md', revision: revisionOf('staged', 'blob-a'), provenance: 'staged', trust: 'observed' }],
  };
  const overlay = await buildOverlay({
    changes: [
      { path: 'docs/rates-v2.md', status: 'renamed', from: 'docs/rates.md' },
      { path: 'docs/old.md', status: 'deleted' },
    ],
    read: async () => '# rates v2\n',
  });
  const merged = mergeOverlay(base, overlay);

  const keys = merged.nodes.map((node) => node.key).sort();
  assert.deepEqual(keys, ['file:docs/kept.md', 'file:docs/rates-v2.md'], 'the renamed and deleted files left rows behind');
  assert.deepEqual(merged.edges, [], 'an edge owned by a tombstoned file survived');
  assert.equal(merged.nodes.some((node) => node.source === 'docs/rates.md'), false, 'a symbol under the old path survived the rename');
  assert.deepEqual(overlay.tombstones, [{ key: 'file:docs/old.md', path: 'docs/old.md' }, { key: 'file:docs/rates.md', path: 'docs/rates.md' }]);
});

test('an overlay row shadows a base row with the same key, and merging is deterministic', async () => {
  const base = { nodes: [stagedNode('docs/rates.md', 'blob-a')], edges: [] };
  const overlay = await buildOverlay({ changes: [{ path: 'docs/rates.md' }], read: async () => '# edited\n' });
  const first = mergeOverlay(base, overlay);
  assert.deepEqual(first.shadowed, ['file:docs/rates.md']);
  assert.equal(first.nodes[0].provenance, 'working-tree');
  assert.equal(first.nodes[0].revision, overlay.nodes[0].revision);
  assert.deepEqual(mergeOverlay(base, overlay), first, 'the merge is not a function of its inputs');
  assert.equal(base.nodes[0].provenance, 'staged', 'the merge modified the base it was given');

  const twice = mergeOverlay(first, overlay);
  assert.deepEqual(twice, first, 'merging the same overlay twice changed the result');
});

test('both backends store one semantics: the same rows read back identical', async () => {
  const base = {
    nodes: [stagedNode('docs/kept.md', 'blob-c')],
    edges: [{ src: 'docs/kept.md', kind: 'imports', dst: 'docs/rates.md', revision: revisionOf('staged', 'blob-c'), provenance: 'staged', trust: 'observed', weight: 2 }],
  };
  const overlay = await buildOverlay({
    changes: [{ path: 'docs/rates.md' }],
    read: async () => '# rates\n',
    edges: [{ src: 'docs/rates.md', kind: 'imports', dst: 'docs/kept.md' }],
  });
  const merged = mergeOverlay(base, overlay);
  assert.equal(merged.edges.length, 2);

  const jsonl = jsonlBackend(await tempFile('overlay.jsonl'));
  const sqlite = sqliteBackend(await tempFile('overlay.sqlite'));
  await jsonl.write(merged);
  await sqlite.write(merged);
  const fromJsonl = await jsonl.read();
  const fromSqlite = await sqlite.read();
  assert.deepEqual(fromSqlite, fromJsonl);
  assert.deepEqual(fromJsonl.nodes.map((node) => node.key), ['file:docs/kept.md', 'file:docs/rates.md']);
  assert.deepEqual(fromJsonl.edges.map((edge) => edge.weight), [2, 1], 'the default weight and the declared one both survive, in source order');

  // Rewriting is idempotent in both: a second write is not an append.
  await jsonl.write(merged);
  await sqlite.write(merged);
  assert.deepEqual(await jsonl.read(), fromJsonl);
  assert.deepEqual(await sqlite.read(), fromSqlite);
});

test('a missing jsonl file reads as no rows, and a malformed line is named', async () => {
  const file = await tempFile('missing.jsonl');
  const backend = jsonlBackend(file);
  assert.deepEqual(await backend.read(), { nodes: [], edges: [] });
  await backend.write({ nodes: [worktreeNode('a.md', 'x')], edges: [] });
  assert.match(await readFile(file, 'utf8'), /"row":"node"/);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, '{"row":"twig"}\n');
  await assert.rejects(() => backend.read(), /names no row kind/);
});

test('the overlay module reads no socket and writes nothing outside the backend it is handed', async () => {
  const source = await readFile(new URL('../src/index/overlay.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:net|node:http|fetch\(|process\.env|Date\.now|new Date\(\)/);
});
