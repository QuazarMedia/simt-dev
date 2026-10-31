import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYS, loadManifest, manifestProblems } from '../src/manifest/schema.mjs';

const scratch = () => mkdtemp(join(tmpdir(), 'simt-manifest-'));

test('a repository without a manifest has no manifest and no problems', async () => {
  const { manifest, exists, problems, version } = await loadManifest(await scratch());
  assert.equal(manifest, null);
  assert.equal(exists, false);
  assert.deepEqual(problems, []);
  assert.equal(version, 1, 'absent means version 1, because every file predates the field');
});

test('a manifest that does not parse is a problem, not a manifest', async () => {
  const root = await scratch();
  await writeFile(join(root, 'simt.json'), '{ "id": "x", }');
  const { manifest, exists, problems } = await loadManifest(root);
  assert.equal(manifest, null, 'half-read content is not a declaration');
  assert.equal(exists, true);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not parse/);
});

test('a known key with an impossible value is named in the repository\'s words', async () => {
  assert.deepEqual(manifestProblems({ mode: 'kernal' }), ['mode must be "full" or "kernel", not "kernal"']);
  assert.deepEqual(manifestProblems({ limits: { fileLines: { warn: 400, error: 100 } } }), ['limits.fileLines must be {warn, error} with error >= warn']);
  assert.deepEqual(manifestProblems({ surfaces: { opencode: true } }), ['surfaces must be null or a list of surface ids']);
});

test('a key this tool does not know is not a problem', () => {
  // The file's own comment invites a repository to keep its keys through a re-init, so
  // refusing an unknown one would make the validator the owner of a repository's file.
  assert.deepEqual(manifestProblems({ id: 'x', note: 'kept by hand' }), []);
});

test('the manifest this repository carries has no problems', async () => {
  // The test that would have caught this table being written from memory: the first
  // draft called `limits.fileLines` a positive integer and `surfaces` an object, and
  // both are wrong in the only manifest the tool has to hand.
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const { problems, exists } = await loadManifest(repo);
  assert.equal(exists, true);
  assert.deepEqual(problems, []);
});

test('every key in the table has an owner and a reason it is there', () => {
  for (const entry of KEYS) {
    assert.ok(entry.owner === 'tool' || entry.owner === 'repo', `${entry.key} has no owner`);
    assert.match(entry.since, /^\d+\.\d+\.\d+$/, `${entry.key} has no version it arrived in`);
    assert.equal(typeof entry.check, 'function', `${entry.key} has no check`);
  }
});
