// Plan 0004 W07: adopt a knowledge repository without fabricating a runner.
//
// The failure this pins: `init` on a docs-only repository inventing a `package.json`, a
// pytest gate, or a build step so that something looks checked. A repository with no
// runner has no runner; it has the checks it declares, and `work.version` is how it says
// so. An unknown version is refused with a remedy rather than half-read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SUPPORTED_WORK_VERSIONS, WORK_VERSION, normalizedWork, validateWork } from '../src/work/config.mjs';
import { readWork } from '../src/work/effective.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';
import { loadManifest } from '../src/manifest/schema.mjs';
import { git, simt, tempDir } from './fixture.mjs';
import { keepTemp } from './fixture.mjs';

async function docsRepo(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-work-config-'));
  keepTemp(root);
  const all = {
    'README.md': '# country knowledge\n',
    'Germany/rates.md': '# rates\n',
    'Germany/sources/rate-source.md': '# source\n',
    'eval/validate.mjs': 'export const check = () => true;\n',
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  return root;
}

test('a version is one this parser reads, and an unknown version is refused with a remedy', () => {
  assert.equal(WORK_VERSION, 2);
  assert.deepEqual([...SUPPORTED_WORK_VERSIONS], [1, 2]);
  assert.deepEqual(validateWork({ version: 2 }), { ok: true, problems: [] });
  assert.deepEqual(validateWork({ version: 1 }), { ok: true, problems: [] }, 'a version-1 declaration stopped being readable');
  const future = validateWork({ version: 3 });
  assert.equal(future.ok, false);
  assert.match(future.problems[0].message, /work\.version must be one of 1, 2/);
  assert.match(future.problems[0].remedy, /"work": \{"version": 2\}/);
  assert.equal(validateWork(null).ok, false);
});

test('a field a version does not carry is refused by name, not read as unknown', () => {
  const scopes = [{ id: 'handbook', paths: ['handbook'], ignore: ['drafts'] }];
  const older = validateWork({ version: 1, scopes });
  assert.equal(older.ok, false);
  assert.equal(older.problems[0].path, 'work.scopes[0].ignore');
  assert.equal(older.problems[0].code, 'field-needs-version');
  assert.match(older.problems[0].message, /is a version 2 field, and this declaration is version 1/);
  assert.match(older.problems[0].remedy, /"version": 2/);
  assert.deepEqual(validateWork({ version: 2, scopes }), { ok: true, problems: [] }, 'version 2 refused its own field');
});

test('a path is repository-relative, and each impossible path names its field and a remedy', () => {
  const parent = validateWork({ version: 2, scopes: [{ id: 'de', paths: ['../elsewhere'] }] });
  assert.equal(parent.problems[0].path, 'work.scopes[0].paths[0]');
  assert.equal(parent.problems[0].code, 'path-outside');
  assert.match(parent.problems[0].remedy, /relative to the repository root/);

  const absolute = validateWork({ version: 2, scopes: [{ id: 'de', paths: ['/srv/docs'] }] });
  assert.equal(absolute.problems[0].code, 'path-outside', 'an absolute path resolves outside the repository it is declared in');

  const ignored = validateWork({ version: 2, scopes: [{ id: 'de', paths: ['de'], ignore: ['../secrets'] }] });
  assert.equal(ignored.problems[0].path, 'work.scopes[0].ignore[0]');
});

test('dot paths, trailing slashes and spaces are one claim each, and a root scope is a claim too', () => {
  const spellings = validateWork({ version: 2, scopes: [{ id: 'a', paths: ['./docs'] }, { id: 'b', paths: ['docs/'] }] });
  assert.ok(spellings.problems.some((problem) => problem.code === 'path-conflict'), 'two spellings of one tree were read as two trees');

  assert.deepEqual(validateWork({ version: 2, scopes: [{ id: 'hand book', paths: ['hand book/docs'] }] }), { ok: true, problems: [] });
  assert.deepEqual(validateWork({ version: 2, scopes: [{ id: 'all', paths: ['.'] }, { id: 'de', paths: ['./Germany/'] }] }), { ok: true, problems: [] });
});

test('a padded path is refused rather than silently claiming nothing', () => {
  const padded = validateWork({ version: 2, scopes: [{ id: 'de', paths: [' Germany'] }] });
  assert.equal(padded.problems[0].path, 'work.scopes[0].paths[0]');
  assert.equal(padded.problems[0].code, 'path-padded');
  assert.match(padded.problems[0].remedy, /without padding/);
});

test('the normalized declaration is the one spelling every reader compares', () => {
  const effective = normalizedWork({
    version: 2,
    scopes: [{ id: 'de', paths: ['./Germany/', 'Germany/'], kind: 'document', validators: ['node eval/validate.mjs'], ignore: ['./drafts'] }],
    targets: [],
  });
  assert.deepEqual(effective.scopes, [
    { id: 'de', paths: ['Germany', 'Germany'], kind: 'document', validators: ['node eval/validate.mjs'], ignore: ['./drafts'] },
  ]);
});

test('an invalid declaration exposes no scope to any reader', async () => {
  const root = await docsRepo({
    'simt.json': JSON.stringify({ work: { version: 1, scopes: [{ id: 'de', paths: ['Germany'], ignore: ['drafts'] }] } }),
  });
  const work = await readWork(root);
  assert.equal(work.declared, true);
  assert.equal(work.ok, false, 'a version-1 declaration carrying a version-2 field was accepted');
  assert.deepEqual(work.scopes, [], 'half of an invalid declaration reached a reader');
  assert.equal(work.problems[0].path, 'work.scopes[0].ignore');
});

test('unknown keys, duplicate ids and duplicate paths are refused, because each is a check that does not exist', () => {
  const unknownTop = validateWork({ version: 1, scope: [] });
  assert.match(unknownTop.problems[0].message, /work\.scope is not a known key/);

  const duplicateId = validateWork({ version: 1, scopes: [{ id: 'de', paths: ['Germany'] }, { id: 'de', paths: ['Germany2'] }] });
  assert.ok(duplicateId.problems.some((p) => /declared twice/.test(p.message)));

  const duplicatePath = validateWork({ version: 1, scopes: [{ id: 'de', paths: ['docs'] }, { id: 'nz', paths: ['docs'] }] });
  assert.ok(duplicatePath.problems.some((p) => /claimed by both/.test(p.message)));

  const target = validateWork({ version: 1, targets: [{ type: 'calculation' }] });
  assert.ok(target.problems.some((p) => /namespace must be a non-empty string/.test(p.message)));

  const scopeKey = validateWork({ version: 1, scopes: [{ id: 'de', paths: ['Germany'], owner: 'me' }] });
  assert.ok(scopeKey.problems.some((p) => /work\.scopes\[0\]\.owner is not a known key/.test(p.message)));
});

test('a docs-only repository adopts with its own checks only: no runner is invented', async () => {
  const root = await tempDir('simt-work-adopt-');
  await git(['init', '-q', root]);
  await writeFile(join(root, 'README.md'), '# country knowledge\n');
  await mkdir(join(root, 'Germany'), { recursive: true });
  await writeFile(join(root, 'Germany', 'rates.md'), '# rates\n');
  await writeFile(join(root, 'simt.json'), `${JSON.stringify({ id: 'fixture', work: { version: 1, scopes: [{ id: 'de', paths: ['Germany'] }] } }, null, 2)}\n`);

  const run = await simt(['init', '--root', root, '--yes', '--no-agents']);
  assert.equal(run.code, 0, `${run.stdout ?? ''}${run.stderr ?? ''}`);

  assert.equal(existsSync(join(root, 'package.json')), false, 'adoption fabricated a package runner');
  assert.equal(existsSync(join(root, 'pyproject.toml')), false, 'adoption fabricated a Python project');
  const manifest = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
  const gates = JSON.stringify(manifest.gates ?? {});
  assert.doesNotMatch(gates, /pytest|npm run (test|lint)|gradle/i, `adoption fabricated a gate: ${gates}`);
  assert.deepEqual(manifest.work, { version: 1, scopes: [{ id: 'de', paths: ['Germany'] }] }, 'the declaration survives re-init unchanged');
});

test('doctor reports an invalid work declaration as a problem with a remedy, before anything runs', async () => {
  const root = await docsRepo({ 'simt.json': `${JSON.stringify({ id: 'fixture', work: { version: 7 } })}\n` });
  const loaded = await loadManifest(root);
  assert.ok(loaded.problems.length > 0, 'an unknown version reached a caller unchallenged');
  assert.match(loaded.problems.join('\n'), /work\.version.*must be one of 1, 2/);
  assert.match(loaded.problems.join('\n'), /remove the key/);
});
