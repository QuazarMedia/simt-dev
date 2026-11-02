// Plan 0004 W08: which scope owns a path, and what an artifact is.
//
// Two failures are pinned here. A country tree is not a package, so scope ownership has to
// be decidable without inventing a package boundary: most specific literal path wins, a
// glob only breaks a tie, and equal specificity is refused rather than ordered by listing.
// And identity has to survive a rename, because a rendered page and its Markdown are one
// artifact and a moved file is still the same document.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  artifactId,
  joinRepresentations,
  obligationsFor,
  remoteIdentity,
  resolveScope,
} from '../src/work/artifacts.mjs';

const SCOPES = [
  { id: 'knowledge', paths: ['docs'] },
  { id: 'de', paths: ['docs/de'] },
  { id: 'de-sources', paths: ['docs/de/sources'] },
  { id: 'reports', paths: ['docs/*/reports'] },
];

test('the most specific literal scope wins, and the tree is not treated as a package', () => {
  assert.deepEqual(resolveScope(SCOPES, 'docs/de/rates.md'), { scope: 'de' });
  assert.deepEqual(resolveScope(SCOPES, 'docs/de/sources/rate.md'), { scope: 'de-sources' });
  assert.deepEqual(resolveScope(SCOPES, 'docs/fr/rates.md'), { scope: 'knowledge' });
  assert.deepEqual(resolveScope(SCOPES, 'other/rates.md'), { scope: null, error: { kind: 'none', candidates: [] } });
});

test('a glob decides only where no literal does, and a deeper literal still outranks it', () => {
  const scopes = [
    { id: 'glob', paths: ['docs/*/reports'] },
    { id: 'de', paths: ['docs/de'] },
  ];
  assert.deepEqual(resolveScope(scopes, 'docs/fr/reports/2024.md'), { scope: 'glob' });
  assert.deepEqual(resolveScope(scopes, 'docs/de/reports/2024.md'), { scope: 'de' }, 'the literal scope is more specific than the glob');
});

test('two scopes of equal specificity are refused instead of ordered by accident', () => {
  const scopes = [
    { id: 'a', paths: ['docs/*/reports'] },
    { id: 'b', paths: ['docs/*/reports'] },
  ];
  assert.deepEqual(resolveScope(scopes, 'docs/de/reports/2024.md'), {
    scope: null,
    error: { kind: 'conflict', candidates: ['a', 'b'] },
  });
});

test('an explicit id survives a rename; a path id is honest about being a path', () => {
  assert.equal(artifactId({ path: 'Germany/rates.md', explicitId: 'de-rates' }), 'de-rates');
  assert.equal(artifactId({ path: 'Germany/rates.md', anchor: 'vat' }), 'Germany/rates.md#vat');
  assert.equal(artifactId({ path: 'Germany/rates-v2.md', renames: { 'Germany/rates-v2.md': 'de-rates' } }), 'de-rates');
  assert.equal(artifactId({ path: 'Germany/rates.md' }), 'Germany/rates.md');
});

test('a remote object is namespace, type and id; a display name is not identity', () => {
  assert.deepEqual(remoteIdentity({ namespace: 'tenant-a', type: 'calculation', id: 'calc-1' }), { id: 'tenant-a:calculation:calc-1' });
  const missing = remoteIdentity({ namespace: 'tenant-a', id: 'calc-1' });
  assert.match(missing.error, /needs type/);
  assert.equal(remoteIdentity({ type: 'calculation', id: 'calc-1' }).error, 'remote identity needs namespace; a display name is not an identity');
});

test('a script under a document scope keeps its executable obligation', () => {
  assert.deepEqual(obligationsFor({ kind: 'document', path: 'Germany/rates.md' }), ['structure', 'links']);
  assert.deepEqual(obligationsFor({ kind: 'document', path: 'Germany/_scripts/render.py' }), ['structure', 'links', 'execute']);
  assert.deepEqual(obligationsFor({ kind: 'source', path: 'src/app.mjs' }), ['test', 'lint', 'execute']);
});

test('representations of one artifact are joined by id, not by directory layout', () => {
  const joined = joinRepresentations([
    { id: 'de-rates', path: 'Germany/rates.md', mediaType: 'text/markdown' },
    { id: 'de-rates', path: 'Germany/rates.html', mediaType: 'text/html' },
    { id: 'de-sources', path: 'Germany/sources/rate.md', mediaType: 'text/markdown' },
  ]);
  assert.deepEqual(joined, [
    {
      id: 'de-rates',
      representations: [
        { path: 'Germany/rates.html', mediaType: 'text/html' },
        { path: 'Germany/rates.md', mediaType: 'text/markdown' },
      ],
    },
    { id: 'de-sources', representations: [{ path: 'Germany/sources/rate.md', mediaType: 'text/markdown' }] },
  ]);
});
