import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TOOLS } from '../src/mcp/tools.mjs';
import { reindex } from '../src/index/store.mjs';
import { BIN, ensureGit, simt, tempDir } from './fixture.mjs';

async function fixture() {
  const root = await tempDir('brief-drilldown-');
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
  await writeFile(join(root, 'src', 'rank.mjs'), 'export function rankRows() {}');
  await writeFile(join(root, 'src', 'merge.mjs'), 'export function mergeRows() {}');
  await writeFile(join(root, 'src', 'ignored.mjs'), 'export function ignored() {}');
  await writeFile(join(root, 'README.md'), '# Repository help');
  await writeFile(join(root, 'test', 'merge.test.mjs'), "import '../src/merge.mjs';");
  await ensureGit(root);
  await reindex(root, { fielded: true });
  return root;
}

test('a drill-down isolates one subtask through CLI and MCP', async () => {
  const root = await fixture();
  const task = 'Fix src/rank.mjs, update src/merge.mjs without touching src/ignored.mjs, and document README.md';
  const result = await simt(['brief', task, '--subtask', '2', '--explain', '--json'], { cwd: root });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.selectedSubtask, 2);
  assert.deepEqual(payload.subtasks.map(({ id }) => id), [2]);
  assert.deepEqual(payload.subtasks[0].files.map(({ path }) => path), ['src/merge.mjs']);
  assert.equal(payload.sections.SUBTASKS, undefined);
  assert.ok(payload.sections.TESTS.some((line) => line.includes('test/merge.test.mjs')));
  assert.ok(payload.sections.CAUTIONS.some((line) => line.includes('Do not edit src/ignored.mjs')));
  assert.equal(payload.constraints[0].subtaskId, 2);
  assert.ok(payload.explain.some((line) => line.startsWith('keep FILES [T2]') && line.includes('/B')));
  const mcp = await TOOLS.find(({ name }) => name === 'brief').run({ root, task, subtask: 2 });
  assert.deepEqual(mcp.sections, payload.sections);
  assert.deepEqual(mcp.subtaskCoverage, payload.subtaskCoverage);
  const invalid = await simt(['brief', task, '--subtask', '4', '--json'], { cwd: root });
  assert.equal(invalid.code, 2);
  assert.match(JSON.parse(invalid.stdout).error, /outside 1–3/u);
});

test('cut packets include coverage and a runnable drill-down with the prompt quoted as data', async () => {
  const root = await fixture();
  const task = "Fix src/rank.mjs, update src/merge.mjs for the message \"don't expand $(printf changed)\", and document README.md";
  const full = await simt(['brief', task, '--retrieval', 'v2', '--budget', '400', '--json'], { cwd: root });
  assert.equal(full.code, 0, full.stdout + full.stderr);
  const answer = JSON.parse(full.stdout);
  assert.ok(answer.cut.length);
  assert.ok(answer.bytes <= 400, answer.text);
  assert.match(answer.text, /cut \d+ items/u);
  assert.equal(answer.subtaskCoverage.length, 3);
  const command = answer.drillDown.find(({ id }) => id === 2).command;
  const child = spawnSync('/bin/sh', ['-c', 'simt() { "$SIMT_TEST_NODE" "$SIMT_TEST_BIN" "$@"; }\n' + command + ' --json'], {
    cwd: root,
    env: { ...process.env, SIMT_TEST_NODE: process.execPath, SIMT_TEST_BIN: BIN },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  const reply = JSON.parse(child.stdout);
  assert.equal(reply.task, task);
  assert.equal(reply.selectedSubtask, 2);
  assert.deepEqual(reply.subtasks[0].files.map(({ path }) => path), ['src/merge.mjs']);
});
