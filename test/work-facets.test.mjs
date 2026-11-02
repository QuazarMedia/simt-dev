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

test('the walk is bounded and says so instead of pretending it saw everything', async () => {
  const files = {};
  for (let index = 0; index < 30; index += 1) files[`docs/page-${index}.md`] = '# page\n';
  const root = await repo(files);
  const facets = await detectFacets(root, { limit: 10 });
  assert.equal(facets.truncated, true);
  assert.ok(kind(facets, 'document').count <= 10);
});
