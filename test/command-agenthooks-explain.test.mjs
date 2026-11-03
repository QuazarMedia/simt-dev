// `simt agent-hooks explain` (ADR-190): one payload in, the reading out.
//
// What the suite pins: the command explains through the hook's own adapter and policy table,
// so a payload the hook denies is denied here with the same class, the same blocked list and
// the same message; a file write names its resource; the operation identity does not depend
// on whether the boundary claims mediation; a payload it cannot read is a usage error rather
// than a silent pass; and the command writes nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { keepTemp } from './fixture.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'simt.mjs');

/** A payload only in the sense the harness documents it: the shell command is its own key. */
const PUSH = { tool_name: 'Bash', tool_input: { command: 'git push origin main' } };
const WRITE = { tool_name: 'Write', tool_input: { file_path: 'notes.md', content: 'x' } };

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-explain-'));
  keepTemp(root);
  const init = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  return root;
}

function explain(root, args, { payload = null } = {}) {
  return spawnSync(process.execPath, [BIN, 'agent-hooks', 'explain', ...args], {
    cwd: root,
    encoding: 'utf8',
    input: payload === null ? '' : JSON.stringify(payload),
  });
}

const parsed = (run) => {
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};

test('a push payload is explained as the decision the hook would make', async () => {
  const root = await repo();
  const out = parsed(explain(root, ['--harness', 'claude'], { payload: PUSH }));
  assert.equal(out.command, 'agent-hooks explain');
  assert.equal(out.harness, 'claude');
  assert.equal(out.described.surface, 'shell');
  assert.equal(out.described.effect, 'push');
  assert.equal(out.described.classified, true);
  assert.equal(out.mediation.verdict, 'deny');
  assert.equal(out.mediation.assurance, 'observe-only');
  assert.deepEqual(out.mediation.blocked, ['push']);
  assert.match(out.mediation.messages.join(' '), /explicit approval/);
});

test('a file write names the resource it reaches', async () => {
  const root = await repo();
  const out = parsed(explain(root, ['--harness', 'claude'], { payload: WRITE }));
  assert.equal(out.described.surface, 'tool');
  assert.equal(out.described.effect, 'local-write');
  assert.equal(out.described.resource.length, 1);
  assert.equal(isAbsolute(out.described.resource[0]), true);
  assert.match(out.described.resource[0], /notes\.md$/);
  assert.equal(out.mediation.verdict, 'allow');
});

test('the mediation claim changes the assurance, not the operation', async () => {
  const root = await repo();
  const observe = parsed(explain(root, ['--harness', 'claude'], { payload: PUSH }));
  const mediated = parsed(explain(root, ['--harness', 'claude', '--mediated'], { payload: PUSH }));
  assert.equal(mediated.mediation.assurance, 'mediated');
  assert.equal(mediated.described.operation, observe.described.operation);
});

test('the payload can be read from a file instead of stdin', async () => {
  const root = await repo();
  const file = join(root, 'push.json');
  await writeFile(file, JSON.stringify(PUSH));
  const out = parsed(explain(root, ['--harness', 'claude', '--payload', file]));
  assert.equal(out.described.effect, 'push');
});

test('an unreadable payload is a usage error, not a silent pass', async () => {
  const root = await repo();
  const empty = explain(root, ['--harness', 'claude']);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /not JSON/);

  const missing = explain(root, ['--harness', 'claude', '--payload', join(root, 'absent.json')]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read --payload/);
});

test('an unknown harness fails and names the harnesses that exist', async () => {
  const root = await repo();
  const run = explain(root, ['--harness', 'no-such-harness'], { payload: PUSH });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /unknown harness/);
  assert.match(run.stderr, /claude/);
});

test('explaining a payload writes nothing', async () => {
  const root = await repo();
  parsed(explain(root, ['--harness', 'claude'], { payload: WRITE }));
  parsed(explain(root, ['--harness', 'claude', '--mediated'], { payload: PUSH }));
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.trim(), '', 'the command wrote to the repository it explained');
});
