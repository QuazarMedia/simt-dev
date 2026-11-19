// `init` previews are previews (review 0005 PR01).
//
// The defect these pin: `init` wrote the companion skill to disk before it decided
// whether to write anything, so an `init --json` that reported nothing written had
// already created `.agents/skills/simt-commands/SKILL.md`, and every refusal left it
// behind. The skill is now a planned target, disclosed from its projected bytes, and
// the assertions below compare the whole tree rather than a list of paths one test
// remembered to check.

import assert from 'node:assert/strict';
import { readdir, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { agentPath } from '../src/agents/render.mjs';
import { git, simt, tempDir } from './fixture.mjs';

const SKILL = join('.agents', 'skills', 'simt-commands', 'SKILL.md');

async function repo() {
  const root = await tempDir('init-preview-');
  await git(['init', '-q', root]);
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2)}\n`);
  await writeFile(join(root, 'README.md'), '# fixture\n');
  return root;
}

/**
 * Every path, link target and byte in the tree, minus `.git`. A preview that changes
 * anything — a file, a mode, a link, a ref — changes this map, so "nothing written"
 * is one comparison instead of a list that grows with each write the tool learns to do.
 */
async function snapshot(root) {
  const out = {};
  const walk = async (dir, rel) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      const key = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) out[key] = `link:${await readlink(full)}`;
      else if (entry.isDirectory()) {
        out[key] = 'dir';
        await walk(full, key);
      } else out[key] = `${(await stat(full)).mode}:${await readFile(full, 'utf8')}`;
    }
  };
  await walk(root, '');
  return out;
}

test('a text preview names the skill it would write and writes nothing', async () => {
  const root = await repo();
  const before = await snapshot(root);
  const run = await simt(['init', '--root', root, '--harness', 'cursor']);
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.code, 0, text);
  assert.match(text, /created\s+\.agents\/skills\/simt-commands\/SKILL\.md/, 'the preview names the skill');
  assert.match(text, /created\s+\.cursor\/agents\/simt-agent\.md/, 'the preview names the agent');
  assert.deepEqual(await snapshot(root), before, 'a preview changed the tree');
});

test('a JSON preview writes nothing either', async () => {
  const root = await repo();
  const before = await snapshot(root);
  const run = await simt(['init', '--root', root, '--harness', 'cursor', '--json']);
  assert.equal(run.code, 0, run.text ?? `${run.stdout}${run.stderr}`);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.written, false);
  assert.ok(payload.agents.some((a) => a.path === SKILL), 'the payload plans the skill');
  assert.deepEqual(await snapshot(root), before, 'a JSON preview changed the tree');
});

test('a malformed region refuses the run and leaves no skill behind', async () => {
  const root = await repo();
  await writeFile(join(root, 'AGENTS.md'), 'hand-written prose\n\n<!-- simt:begin -->\nnever closed\n');
  const before = await snapshot(root);
  const run = await simt(['init', '--root', root, '--harness', 'cursor', '--yes']);
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.notEqual(run.code, 0, text);
  assert.match(text, /malformed/i);
  assert.deepEqual(await snapshot(root), before, 'a refused run changed the tree');
});

test('the applied skill and its disclosure match the preview, and undo removes it', async () => {
  const root = await repo();
  const run = await simt(['init', '--root', root, '--harness', 'cursor', '--yes']);
  assert.equal(run.code, 0, run.text ?? `${run.stdout}${run.stderr}`);
  assert.match(await readFile(join(root, SKILL), 'utf8'), /name: simt-commands/);
  assert.ok(await readFile(join(root, agentPath('cursor')), 'utf8'));
  const region = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.match(region, /## Disclosure/);
  assert.match(region, /- simt-commands — /);

  const undo = await simt(['undo', '--root', root, '--yes']);
  assert.equal(undo.code, 0, undo.text ?? `${undo.stdout}${undo.stderr}`);
  await assert.rejects(readFile(join(root, SKILL)), 'undo restores the pre-adoption tree');
});

test('--no-agents skips the skill with the agent files and says so', async () => {
  const root = await repo();
  const run = await simt(['init', '--root', root, '--harness', 'cursor', '--no-agents', '--yes']);
  assert.equal(run.code, 0, run.text ?? `${run.stdout}${run.stderr}`);
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.match(text, /skipped\s+agent files, the companion skill and agent-hooks/);
  await assert.rejects(readFile(join(root, SKILL)), 'an opted-out adoption installs no skill');
  await assert.rejects(readFile(join(root, agentPath('cursor'))), 'an opted-out adoption installs no agent');
});
