// `init --harness` and the scope every agent command reads (ADR-141).
//
// The change these pin: a repository selects its harness once, at adoption, and the agent
// commands follow that selection. Saying nothing selects nothing - the old default wrote
// six readers into a repository that asked for one, and the tests here would have passed
// against that default because they never asked what "nothing" should do.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { agentPath } from '../src/agents/render.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';
import { git, simt, tempDir } from './fixture.mjs';

async function repo() {
  const root = await tempDir('init-harness-');
  await git(['init', '-q', root]);
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2)}\n`),
  );
  await import('node:fs/promises').then(({ writeFile }) => writeFile(join(root, 'README.md'), '# fixture\n'));
  return root;
}

test('init --harness records the harness in surfaces and writes only that reader', async () => {
  const root = await repo();
  const run = await simt(['init', '--root', root, '--harness', 'cursor', '--yes']);
  assert.equal(run.code, 0, run.text);

  const manifest = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
  assert.deepEqual(manifest.surfaces, ['cursor'], 'the harness is the recorded surface');

  assert.ok(existsSync(join(root, agentPath('cursor'))), 'the requested reader has its agent file');
  assert.ok(existsSync(join(root, '.cursor/hooks.json')), 'the requested reader has its hooks entry');
  for (const other of ['claude', 'codex', 'gemini', 'antigravity']) {
    assert.equal(existsSync(join(root, agentPath(other))), false, `${other} was written without being selected`);
  }
});

test('init without --harness selects nothing, writes no agent files, and says how to select one', async () => {
  const root = await repo();
  const run = await simt(['init', '--root', root, '--yes']);
  assert.equal(run.code, 0, run.text);

  const manifest = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
  assert.equal(manifest.surfaces ?? null, null, 'an unselected adoption records no surface');

  for (const id of ['cursor', 'claude', 'codex', 'gemini', 'antigravity', 'opencode']) {
    assert.equal(existsSync(join(root, agentPath(id))), false, `${id} was written by an adoption that selected nothing`);
  }
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.match(text, /no --harness given, so no harness is selected/);
  assert.match(text, /init --harness <id>, one of: /);
});

test('init --harness rejects an id this tool does not render, before writing anything', async () => {
  const root = await repo();
  const run = await simt(['init', '--root', root, '--harness', 'windsurf', '--yes']);
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.code, 2, text);
  assert.match(text, /unknown harness `windsurf`/);
  assert.equal(existsSync(join(root, MANIFEST_FILE)), false, 'the refusal wrote a manifest');
});
