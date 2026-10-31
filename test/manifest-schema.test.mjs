import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYS, loadManifest, manifestProblems, registerNamespace, registeredNamespaces } from '../src/manifest/schema.mjs';

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
  assert.match(problems[0], /^unparseable: /);
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

test('the generated keys are the rows the table marks generated', async () => {
  // A second list beside the table is the drift this module exists to end: the flag is
  // the declaration, and this is the only place the set is spelled.
  const { GENERATED_KEYS } = await import('../src/projection/manifest.mjs');
  const flagged = KEYS.filter((entry) => entry.generated === true).map((entry) => entry.key).sort();
  assert.deepEqual([...GENERATED_KEYS].sort(), flagged);
  assert.deepEqual(flagged, ['$comment', 'projection']);
});

test('readManifest keeps the shape its callers print, and only calls an unreadable file an error', async () => {
  const { readManifest } = await import('../src/projection/manifest.mjs');
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const good = await readManifest(repo);
  assert.equal(good.exists, true);
  assert.equal(good.error, null, 'a manifest with a value the schema dislikes is still a manifest');

  const root = await scratch();
  await writeFile(join(root, 'simt.json'), '{ nope');
  const broken = await readManifest(root);
  assert.equal(broken.manifest, null);
  assert.match(broken.error, /^unparseable: /);
});

test('a namespace registers its keys, and they are checked like any other', () => {
  // Plan 0004's `work` is the first consumer; this is the seam it uses rather than a
  // second manifest table.
  const count = registerNamespace('work', [
    { key: 'threshold', since: '0.9.0', check: (v) => (Number.isInteger(v) && v >= 0 ? null : 'must be a non-negative integer') },
  ]);
  assert.equal(count, 1);
  assert.deepEqual(registeredNamespaces(), ['work']);
  assert.deepEqual(manifestProblems({ work: { threshold: -1 } }), ['work.threshold: must be a non-negative integer']);
  assert.deepEqual(manifestProblems({ work: { threshold: 3, note: 'kept by hand' } }), [], 'an unregistered key in a namespace is not an error');
  assert.deepEqual(manifestProblems({ work: 'not an object' }), [], 'a namespace that is not an object is not this table business');
});

test('a namespace cannot shadow a manifest key or register itself twice', () => {
  assert.throws(() => registerNamespace('mode', [{ key: 'x', check: () => null }]), /already a manifest key/);
  assert.throws(() => registerNamespace('work', [{ key: 'x', check: () => null }]), /already registered/);
  assert.throws(() => registerNamespace('Bad Name', [{ key: 'x', check: () => null }]), /lower-case/);
  assert.throws(() => registerNamespace('other', []), /at least one key/);
  assert.throws(() => registerNamespace('other2', [{ key: 'x' }]), /no check/);
});
