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

import { WORK_VERSION, validateWork } from '../src/work/config.mjs';
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

test('the namespace is versioned exactly, and an unknown version is refused with a remedy', () => {
  assert.equal(WORK_VERSION, 1);
  assert.deepEqual(validateWork({ version: 1 }), { ok: true, problems: [] });
  const future = validateWork({ version: 2 });
  assert.equal(future.ok, false);
  assert.match(future.problems[0].message, /work\.version must be 1/);
  assert.match(future.problems[0].remedy, /"work": \{"version": 1\}/);
  assert.equal(validateWork(null).ok, false);
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
  assert.match(loaded.problems.join('\n'), /work\.version.*must be 1/);
  assert.match(loaded.problems.join('\n'), /remove the key/);
});
