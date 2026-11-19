// Plan 0006 WK03: a scoped corpus built from the files a repository declared.
//
// What this pins, in the order the failures matter:
//
//   * A denied path is refused before its bytes are read. A corpus that reads first and
//     filters afterwards has already put private content in memory, a log and possibly a
//     shared view.
//   * A symlink is a row, not a read.
//   * Every candidate is in the inventory with a reason, so a file that stopped being indexed
//     says why instead of disappearing.
//   * An incremental build equals a cold one, and a previous corpus cannot resurrect a file
//     the current declaration excludes.
//   * Byte ranges index the original bytes - the property a multilingual citation depends on.
//   * Committed, staged and working-tree content are three labelled states.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ALWAYS_DENIED, CORPUS_DIR, buildCorpus, blobIdOf, policyDigest, revisionOfSource } from '../src/knowledge/corpus.mjs';
import { git, simt, tempDir } from './fixture.mjs';

const scope = { id: 'docs', paths: ['docs'], kind: 'document' };
const md = (text) => ({ tracked: true, bytes: Buffer.byteLength(text) });
const reader = (files) => async (path) => (Object.hasOwn(files, path) ? Buffer.from(files[path], 'utf8') : null);
const sha256 = (text) => `sha256-${createHash('sha256').update(text, 'utf8').digest('hex')}`;

test('a multilingual document keeps anchors, byte ranges and its own digest', async () => {
  const text = '# Preise\n\nDie Gebühr beträgt 5 EUR.\n\n## 料金\n\n手数料は5ユーロです。\n';
  const blob = blobIdOf(Buffer.from(text, 'utf8'));
  const corpus = await buildCorpus({
    scope,
    candidates: [{ path: 'docs/preise.md', ...md(text), headBlob: blob, indexBlob: blob }],
    policy: { deny: ALWAYS_DENIED },
    read: reader({ 'docs/preise.md': text }),
  });

  assert.equal(corpus.schema, 2);
  assert.equal(corpus.scope, 'docs');
  assert.equal(corpus.counts.indexed, 1);
  assert.ok(corpus.units.length >= 2, 'the document yielded no sections');
  const bytes = Buffer.from(text, 'utf8');
  for (const unit of corpus.units) {
    assert.equal(unit.basis, 'section');
    assert.equal(typeof unit.anchor === 'string' && unit.anchor.length > 0, true, 'a unit carries no anchor');
    assert.equal(unit.artifact, `docs/preise.md#${unit.anchor}`);
    assert.equal(unit.digest, sha256(unit.text), 'the unit digest is not its own text');
    assert.equal(bytes.subarray(unit.byteStart, unit.byteEnd).toString('utf8'), unit.text, 'the byte range does not index the document');
    assert.equal(unit.sourceDigest, sha256(text));
    assert.equal(unit.provenance, 'committed');
    assert.equal(unit.revision, `committed:${blob}`);
  }
  const japanese = corpus.units.find((unit) => unit.text.includes('手数料'));
  assert.ok(japanese !== undefined, 'a non-ASCII section was lost');
  // The heading sits at byte N and character M, and N > M: a range counted in characters
  // would cite the wrong span here and on every other non-ASCII document.
  const heading = text.indexOf('## 料金');
  assert.equal(japanese.byteStart, Buffer.byteLength(text.slice(0, heading)));
  assert.ok(japanese.byteStart > heading, 'the fixture stopped being non-ASCII');
});

test('every refused candidate is a row with a reason, and policy refuses before the reader', async () => {
  const read = [];
  const files = {
    'docs/kept.md': '# kept\n',
    'docs/generated.md': '<!-- Generated file. Do not edit. -->\n# spec\n',
    'docs/huge.md': '# huge\n',
    'docs/picture.pdf': 'not really a pdf\n',
    'docs/gone.md': null,
  };
  const corpus = await buildCorpus({
    scope: { ...scope, ignore: ['drafts'] },
    candidates: [
      { path: 'docs/kept.md', ...md(files['docs/kept.md']) },
      { path: 'docs/drafts/item.md', ...md('# draft\n') },
      { path: 'docs/private/secret.md', ...md('# secret token\n') },
      { path: 'docs/generated.md', ...md(files['docs/generated.md']) },
      { path: 'docs/huge.md', tracked: true, bytes: 10_000 },
      { path: 'docs/picture.pdf', ...md(files['docs/picture.pdf']) },
      { path: 'docs/gone.md', ...md('# gone\n') },
      { path: 'docs/link.md', symlink: true },
      { path: 'docs/untracked.md', tracked: false, bytes: 8 },
      { path: '../escape.md', ...md('# escape\n') },
    ],
    policy: { deny: ['docs/private'], maxBytes: 1024 },
    read: async (path) => {
      read.push(path);
      return files[path] == null ? null : Buffer.from(files[path], 'utf8');
    },
  });

  const stateOf = (path) => corpus.inventory.find((row) => row.path === path)?.state;
  assert.equal(stateOf('docs/kept.md'), 'indexed');
  assert.equal(stateOf('docs/drafts/item.md'), 'ignored');
  assert.equal(stateOf('docs/private/secret.md'), 'denied');
  assert.equal(stateOf('docs/generated.md'), 'generated');
  assert.equal(stateOf('docs/huge.md'), 'too-large');
  assert.equal(stateOf('docs/picture.pdf'), 'unsupported');
  assert.equal(stateOf('docs/gone.md'), 'missing');
  assert.equal(stateOf('docs/link.md'), 'symlink');
  assert.equal(stateOf('docs/untracked.md'), 'untracked');
  assert.equal(stateOf('../escape.md'), 'outside');

  assert.deepEqual(read.sort(), ['docs/generated.md', 'docs/gone.md', 'docs/kept.md', 'docs/picture.pdf'], 'a refused path was read');
  assert.doesNotMatch(JSON.stringify(corpus.units), /secret token/, 'denied content reached a unit');
  assert.doesNotMatch(JSON.stringify(corpus.inventory.filter((row) => row.state !== 'denied')), /secret/, 'a denied path reached a shared row');
  assert.equal(corpus.counts.candidates, 10);
  assert.equal(corpus.counts.indexed, 1);
  assert.equal(corpus.counts.units, 1);
});

test('cold and incremental builds are the same corpus, and reuse is counted', async () => {
  const files = { 'docs/a.md': '# a\n\nalpha\n', 'docs/b.md': '# b\n\nbeta\n' };
  const candidates = [
    { path: 'docs/a.md', ...md(files['docs/a.md']) },
    { path: 'docs/b.md', ...md(files['docs/b.md']) },
  ];
  const build = (previous) => buildCorpus({ scope, candidates, policy: { deny: ALWAYS_DENIED }, previous, read: reader(files) });

  const cold = await build(null);
  const warm = await build(cold);
  assert.deepEqual(warm.units, cold.units, 'the incremental build is not the cold one');
  assert.deepEqual(warm.inventory, cold.inventory);
  assert.equal(warm.policy, cold.policy);
  assert.equal(warm.reused, 2);
  assert.equal(warm.counts.units, cold.counts.units);
});

test('a changed policy invalidates reuse and removes what it no longer includes', async () => {
  const files = { 'docs/a.md': '# a\n\nalpha\n', 'docs/secret.md': '# secret\n\nprivate\n' };
  const candidates = [
    { path: 'docs/a.md', ...md(files['docs/a.md']) },
    { path: 'docs/secret.md', ...md(files['docs/secret.md']) },
  ];

  const cold = await buildCorpus({ scope, candidates, policy: { deny: ALWAYS_DENIED }, read: reader(files) });
  assert.equal(cold.counts.indexed, 2);

  const narrowed = await buildCorpus({
    scope,
    candidates,
    policy: { deny: [...ALWAYS_DENIED, 'docs/secret.md'] },
    previous: cold,
    read: reader(files),
  });
  assert.notEqual(narrowed.policy, cold.policy);
  assert.equal(narrowed.reused, 0, 'a unit from the wider policy was reused under a narrower one');
  assert.equal(narrowed.inventory.find((row) => row.path === 'docs/secret.md')?.state, 'denied');
  assert.equal(narrowed.units.some((unit) => unit.path === 'docs/secret.md'), false, 'an excluded file kept its units');
  assert.ok(narrowed.units.some((unit) => unit.path === 'docs/a.md'));
});

test('a stale corpus cannot carry content a symlink or denial removed', async () => {
  const files = { 'docs/kept.md': '# kept\n\nkept\n' };
  const first = await buildCorpus({
    scope,
    candidates: [
      { path: 'docs/kept.md', ...md(files['docs/kept.md']) },
      { path: 'docs/moved.md', ...md('# moved\n\nold\n') },
    ],
    policy: { deny: ALWAYS_DENIED },
    read: reader({ ...files, 'docs/moved.md': '# moved\n\nold\n' }),
  });
  assert.equal(first.units.some((unit) => unit.path === 'docs/moved.md'), true);

  const second = await buildCorpus({
    scope,
    candidates: [
      { path: 'docs/kept.md', ...md(files['docs/kept.md']) },
      { path: 'docs/moved.md', symlink: true },
    ],
    policy: { deny: ALWAYS_DENIED },
    previous: first,
    read: reader(files),
  });
  assert.equal(second.units.some((unit) => unit.path === 'docs/moved.md'), false, 'a stale unit survived under a symlink');
});

test('a rename is recorded by digest, and the moved document keeps no row under its old path', async () => {
  const text = '# Rates\n\nretention\n';
  const first = await buildCorpus({
    scope,
    candidates: [{ path: 'docs/old.md', ...md(text) }],
    policy: { deny: ALWAYS_DENIED },
    read: reader({ 'docs/old.md': text }),
  });
  const second = await buildCorpus({
    scope,
    candidates: [{ path: 'docs/new.md', ...md(text) }],
    policy: { deny: ALWAYS_DENIED },
    previous: first,
    read: reader({ 'docs/new.md': text }),
  });

  const row = second.inventory.find((entry) => entry.path === 'docs/new.md');
  assert.equal(row.renamedFrom, 'docs/old.md');
  assert.equal(second.units.every((unit) => unit.path === 'docs/new.md'), true);
  assert.equal(second.units[0].artifact, `docs/new.md#${second.units[0].anchor}`, 'a rename silently moved the artifact id');
});

test('committed, staged and working-tree content are three labelled states', async () => {
  const old = blobIdOf(Buffer.from('# one\n'));
  const next = blobIdOf(Buffer.from('# two\n'));
  assert.deepEqual(revisionOfSource({ head: old, index: old, worktree: old }), { provenance: 'committed', revision: `committed:${old}` });
  assert.deepEqual(revisionOfSource({ head: old, index: next, worktree: next }), { provenance: 'staged', revision: `staged:${next}` });
  assert.deepEqual(revisionOfSource({ head: old, index: old, worktree: next }), { provenance: 'working-tree', revision: `worktree:${next}` });
  assert.deepEqual(revisionOfSource({ head: null, index: null, worktree: next }), { provenance: 'working-tree', revision: `worktree:${next}` });

  const text = '# two\n';
  const corpus = await buildCorpus({
    scope,
    candidates: [{ path: 'docs/edit.md', ...md(text), headBlob: old, indexBlob: old }],
    policy: { deny: ALWAYS_DENIED },
    read: reader({ 'docs/edit.md': text }),
  });
  assert.equal(corpus.units[0].provenance, 'working-tree');
  assert.match(corpus.units[0].revision, /^worktree:/);
});

test('a heading-less source cites the file, not a fragment that does not exist', async () => {
  const text = 'export const app = () => 1;\n';
  const corpus = await buildCorpus({
    scope: { id: 'code', paths: ['src'], kind: 'source' },
    candidates: [{ path: 'src/app.mjs', ...md(text) }],
    policy: { deny: ALWAYS_DENIED },
    read: reader({ 'src/app.mjs': text }),
  });
  assert.equal(corpus.units.length, 1);
  assert.equal(corpus.units[0].anchor, '');
  assert.equal(corpus.units[0].artifact, 'src/app.mjs');
});

test('the policy digest ignores ordering and changes with every decision it covers', () => {
  const one = policyDigest({ deny: ['b', '.simt'], maxBytes: 10 });
  assert.equal(one, policyDigest({ deny: ['.simt', 'b', 'b'], maxBytes: 10 }));
  assert.notEqual(one, policyDigest({ deny: ['b'], maxBytes: 10 }));
  assert.notEqual(one, policyDigest({ deny: ['b', '.simt'], maxBytes: 11 }));
});

test('the module reads no clock, no network and no filesystem', async () => {
  const source = readFileSync(new URL('../src/knowledge/corpus.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.now|new Date\(\)/);
});

// --- the command, against a real repository ---------------------------------

async function repo(files, work = { scopes: [{ id: 'docs', paths: ['docs'], kind: 'document', ignore: ['draft.md'] }], version: 2 }) {
  const root = await tempDir('simt-corpus-');
  await git(['-C', root, 'init', '-q']);
  writeFileSync(join(root, 'simt.json'), `${JSON.stringify({ work }, null, 2)}\n`);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'fixture']);
  return root;
}

const build = async (root, args = []) => {
  const run = await simt(['knowledge', 'build', '--scope', 'docs', '--root', root, '--json', ...args]);
  assert.equal(run.code, 0, run.stderr);
  return JSON.parse(run.stdout);
};

test('knowledge build previews, writes under the ignored area, and rebuilds to the same bytes', async () => {
  const root = await repo({ 'docs/rates.md': '# Rates\n\nRetention is 30 days.\n', 'docs/draft.md': '# Draft\n' });
  const corpusPath = join(root, CORPUS_DIR, 'docs.json');

  const preview = await build(root);
  assert.equal(preview.written, false);
  assert.equal(preview.changed, true);
  assert.equal(existsSync(corpusPath), false, 'the preview wrote a corpus');
  assert.equal(preview.counts.indexed, 1, 'the ignored draft was indexed');
  assert.equal(preview.inventory.find((row) => row.path === 'docs/draft.md')?.state, 'ignored');
  assert.match(preview.remedy, /simt knowledge build --scope docs --yes/);

  const applied = await build(root, ['--yes']);
  assert.equal(applied.written, true);
  const stored = JSON.parse(readFileSync(corpusPath, 'utf8'));
  assert.equal(stored.scope, 'docs');
  assert.equal(stored.schema, 2);
  assert.equal(stored.units[0].provenance, 'committed', 'an unchanged committed file was not labelled committed');
  assert.equal(stored.units[0].path, 'docs/rates.md');

  const again = await build(root, ['--yes']);
  assert.equal(again.changed, false);
  assert.equal(again.written, false);
  assert.deepEqual(again.units, applied.units);
  assert.equal(again.reused, 1);

  // Derived state under `.simt/` is not journaled, so the way back from a bad corpus is a
  // rebuild, and a rebuild after deleting the file is the same bytes as the incremental one.
  const lost = readFileSync(corpusPath, 'utf8');
  const { rm } = await import('node:fs/promises');
  await rm(corpusPath);
  const rebuilt = await build(root, ['--yes']);
  assert.equal(rebuilt.written, true);
  assert.equal(readFileSync(corpusPath, 'utf8'), lost, 'a cold rebuild produced different bytes');
});

test('knowledge build refuses an undeclared scope by name, before reading anything', async () => {
  const root = await repo({ 'docs/a.md': '# a\n' });
  const run = await simt(['knowledge', 'build', '--scope', 'handbook', '--root', root]);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /`handbook` is not a declared scope/);
  assert.match(run.stderr, /declared scopes are `docs`/);
});
