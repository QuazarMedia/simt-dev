// Plan 0004 W06: describe the work without replacing stack detection.
//
// The regression this pins is the one the investigation found in a real knowledge
// repository: `doctor` reported stack `[react]` because a supporting visualisation was a
// `.tsx` file, which says nothing about the product being documents. Facets answer that
// question additively - the incidental source file adds a kind, and the document
// obligations survive it. Nothing here may remove a code gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ARTIFACT_KINDS, detectFacets } from '../src/work/facets.mjs';
import { keepTemp } from './fixture.mjs';

async function repo(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-facets-'));
  keepTemp(root);
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  return root;
}

const kind = (facets, name) => facets.artifactKinds.find((row) => row.kind === name);
const activity = (facets, name) => facets.activities.find((row) => row.activity === name);

test('a document repository is a document repository, whatever its visualisation is written in', async () => {
  const root = await repo({
    'README.md': '# country notes\n',
    'Germany/sources/rate.md': '# source\n',
    'Germany/generate.mjs': 'export const render = () => 1;\n',
    'eval/validate.mjs': 'export const check = () => true;\n',
    'eval/tools/chart.tsx': 'export const Chart = () => null;\n',
  });
  const facets = await detectFacets(root);
  assert.equal(kind(facets, 'document').count, 2, 'the documents are still artifacts');
  assert.equal(kind(facets, 'source').count, 3, 'the supporting code is still source');
  assert.equal(activity(facets, 'research').evidence.length, 1, 'a sources/ tree is research');
  assert.ok(activity(facets, 'generate'), 'generators are an activity, not a stack');
  assert.ok(activity(facets, 'validate'), 'validators are an activity');
  assert.deepEqual(facets.executionLoci, [{ locus: 'local', evidence: ['.'] }], 'no remote target was declared');
  assert.equal(facets.configured, false);
});

test('a single incidental source file does not remove the document obligations', async () => {
  const bare = await repo({ 'Germany/rates.md': '# rates\n', 'NewZealand/rates.md': '# rates\n' });
  const withTsx = await repo({
    'Germany/rates.md': '# rates\n',
    'NewZealand/rates.md': '# rates\n',
    'visual/chart.tsx': 'export const Chart = () => null;\n',
  });
  const before = await detectFacets(bare);
  const after = await detectFacets(withTsx);
  assert.deepEqual(before.artifactKinds.map((row) => row.kind), ['document']);
  assert.deepEqual(after.artifactKinds.map((row) => row.kind), ['document', 'source']);
  assert.equal(kind(after, 'document').count, kind(before, 'document').count);
});

test('a recipe becomes an operation only when its contract declares a mutation', async () => {
  const inert = await repo({ 'recipes/create.md': '# create\n\nRun the client.\n' });
  assert.equal(kind(await detectFacets(inert), 'recipe').count, 1);
  assert.equal(activity(await detectFacets(inert), 'operate'), undefined);

  const mutating = await repo({ 'recipes/create.md': '# create\n\n@mutates\n@not_idempotent\n' });
  const facets = await detectFacets(mutating);
  assert.equal(kind(facets, 'recipe').count, 1);
  assert.ok(activity(facets, 'operate'), 'a declared mutation is remote work, whatever path it sits on');
});

test('a Python helper under recipes/ is both kinds, and the ambiguity is reported rather than guessed', async () => {
  const root = await repo({ 'recipes/helper.py': 'print("hi")\n' });
  const facets = await detectFacets(root);
  assert.deepEqual(facets.ambiguous, [{ path: 'recipes/helper.py', candidates: ['source', 'recipe'] }]);
  assert.ok(kind(facets, 'source'), 'the executable obligations of the helper are not dropped');
  assert.ok(kind(facets, 'recipe'), 'nor is the recipe it graduates into');
});

test('declared targets add a remote locus; absent config changes nothing', async () => {
  const plain = await repo({ 'pkg.py': 'print(1)\n' });
  assert.deepEqual((await detectFacets(plain)).executionLoci.map((row) => row.locus), ['local']);

  const remote = await repo({
    'pkg.py': 'print(1)\n',
    'simt.json': JSON.stringify({ work: { version: 1, targets: [{ namespace: 't', type: 'calculation' }] } }),
  });
  const facets = await detectFacets(remote);
  assert.deepEqual(facets.executionLoci.map((row) => row.locus), ['local', 'remote']);
  assert.equal(kind(facets, 'remote-object').count, 1);
  assert.deepEqual(ARTIFACT_KINDS, ['source', 'document', 'dataset', 'recipe', 'remote-object']);
});

test('a remote object is a declaration, and its basis says so', async () => {
  const root = await repo({
    'pkg.py': 'print(1)\n',
    'simt.json': JSON.stringify({ work: { version: 2, targets: [{ namespace: 't', type: 'calculation' }] } }),
  });
  const facets = await detectFacets(root);
  assert.equal(kind(facets, 'remote-object').basis, 'declared', 'a kind only a declaration can produce was reported as inferred');
  assert.equal(kind(facets, 'source').basis, 'inferred');
});

test('the walk is bounded and says so instead of pretending it saw everything', async () => {
  const files = {};
  for (let index = 0; index < 30; index += 1) files[`docs/page-${index}.md`] = '# page\n';
  const root = await repo(files);
  const facets = await detectFacets(root, { limit: 10 });
  assert.equal(facets.truncated, true);
  assert.ok(kind(facets, 'document').count <= 10);
});

test('a configured scope decides the kind, and the answer says so', async () => {
  const root = await repo({
    'handbook/intro.rst': 'Introduction\n',
    'simt.json': JSON.stringify({ work: { version: 2, scopes: [{ id: 'handbook', paths: ['handbook'], kind: 'document' }] } }),
  });
  const facets = await detectFacets(root);
  const documents = facets.artifactKinds.find((row) => row.kind === 'document');
  assert.equal(documents.basis, 'declared', 'a corpus the sampler does not recognise was not counted as documents');
  assert.equal(documents.count, 1);
  assert.ok(documents.evidence.includes('simt.json#work.scopes'));
  assert.deepEqual(facets.scopes, [{ id: 'handbook', kind: 'document', paths: ['handbook'] }]);
  assert.equal(facets.configured, true);
});

test('an inferred kind says it is inferred, and an invalid declaration decides nothing', async () => {
  const inferred = await repo({ 'Germany/rates.md': '# rates\n' });
  assert.equal(kind(await detectFacets(inferred), 'document').basis, 'inferred');

  const invalid = await repo({
    'handbook/intro.rst': 'x\n',
    'simt.json': JSON.stringify({ work: { version: 2, scopes: [{ id: 'handbook', paths: ['../outside'], kind: 'document' }] } }),
  });
  const facets = await detectFacets(invalid);
  assert.deepEqual(facets.scopes, []);
  assert.equal(facets.artifactKinds.find((row) => row.kind === 'document'), undefined);
});

test('PR09: a legacy manifest still declares its remote targets', async () => {
  // The raw read of `simt.json` lost every repository that had not been renamed yet, so
  // the same manifest `check` read correctly made facets report no remote object.
  const root = await repo({
    'README.md': '# notes\n',
    'Germany/rates.md': '# rates\n',
    'simt-dev.json': JSON.stringify({ work: { targets: [{ id: 'vault', kind: 'bucket' }] } }),
  });
  const facets = await detectFacets(root);
  assert.equal(facets.configured, true, 'the legacy manifest was not read');
  assert.equal(kind(facets, 'remote-object').count, 1);
  assert.deepEqual(facets.executionLoci.at(-1), { locus: 'remote', evidence: ['simt.json#work.targets'] });
});

test('PR09: an invalid work declaration is not a declaration', async () => {
  // `work.targets` as a string is what the loader rejects; reading it raw reported it as
  // configured and then counted its characters as targets.
  const root = await repo({
    'README.md': '# notes\n',
    'simt.json': JSON.stringify({ work: { targets: 'vault' } }),
  });
  const facets = await detectFacets(root);
  assert.equal(facets.configured, false);
  assert.equal(kind(facets, 'remote-object'), undefined);
});
