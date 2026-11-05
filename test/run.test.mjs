// `run(command, input)` answers with a result instead of printing one (review 0003 Q63).
//
// The sink is the boundary that makes this true for commands that were written to print.
// These tests pin the three promises a caller depends on: nothing reaches the process's
// streams, the exit code survives, and a writer's plan comes back without being applied.
//
// "Nothing reaches the streams" is proved in a child process rather than by patching
// `process.stdout.write` in this one: the test runner writes its own protocol to stdout,
// so a patch here measures the reporter as much as the command.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { renderJson, renderText, run } from '../src/run.mjs';
import { BEGIN, END, README_FILE } from '../src/docs/commands.mjs';

const exec = promisify(execFile);
const RUN_URL = new URL('../src/run.mjs', import.meta.url).href;

test('a command that prints answers with its text, and writes nothing to the process', async () => {
  const script = `
    import { run, renderText } from ${JSON.stringify(RUN_URL)};
    const result = await run('status', { flags: { line: true }, root: process.cwd() });
    process.stdout.write('RESULT ' + JSON.stringify({ code: result.code, bytes: renderText(result).length }) + '\\n');
  `;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd() });
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, `only the sentinel reached stdout, got: ${stdout.slice(0, 200)}`);
  const sentinel = JSON.parse(lines[0].replace(/^RESULT /, ''));
  // The gate's verdict is not what this test is about: a repository with findings answers
  // 1, and the promise under test is that the verdict arrives as a result.
  assert.ok([0, 1].includes(sentinel.code));
  assert.ok(sentinel.bytes > 0, 'the command produced text');
});

test('a command that answers in JSON hands back the document', async () => {
  const result = await run('status', { flags: { line: true, json: true }, root: process.cwd() });
  assert.equal(result.documents.length, 1);
  assert.equal(result.text, '');
  assert.equal(renderJson(result).command, 'status');
});

test('a run result carries the same exit code the dispatcher would name (A13)', async () => {
  const result = await run('status', { flags: { line: true, json: true }, root: process.cwd() });
  assert.equal(renderJson(result).exitCode, result.code);
  assert.equal(renderJson(result).ok, result.code === 0);
});

test('a superseded flag is named in the run result, as it is on stderr (A13)', async () => {
  const result = await run('sync', { flags: { check: true, json: true }, root: process.cwd() });
  assert.equal(renderJson(result).deprecated.check, 'sync');
});

test('a writer previews into the result and writes nothing without --yes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-run-'));
  try {
    const result = await run('docs commands', { flags: { root } });
    assert.equal(result.code, 0);
    assert.match(renderText(result), /plan/);
    assert.deepEqual(await readdir(root), [], 'no file was written');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the same writer applies when asked, through the same call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-run-'));
  try {
    const result = await run('docs commands', { flags: { root, yes: true } });
    assert.equal(result.code, 0);
    assert.match(renderText(result), /write/);
    const page = await readFile(join(root, 'docs', 'commands', 'README.md'), 'utf8');
    assert.ok(page.includes('simt status'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a flag the command does not take is a usage error, in the result', async () => {
  const result = await run('status', { flags: { frozen: true } });
  assert.equal(result.code, 2);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /--frozen is not a flag of `status`/);
});

test('an unknown command is refused with the usage code', async () => {
  const result = await run('not a command');
  assert.equal(result.code, 2);
  assert.match(result.error.message, /unknown command/);
});

test('a gate keeps its exit code, its notes and its text in the result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-run-'));
  try {
    const result = await run('check', { flags: { root } });
    assert.equal(result.ok, result.code === 0);
    assert.ok(result.text.length > 0 || result.documents.length === 1, 'the gate answered');
    assert.ok(Array.isArray(result.notes));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('two commands in one process keep their own documents', async () => {
  const [status, plan] = await Promise.all([
    run('status', { flags: { line: true, json: true }, root: process.cwd() }),
    run('plan status', { flags: { json: true }, root: process.cwd() }),
  ]);
  // Under a process-wide envelope the second call's command path overwrote the first, so
  // one document described an invocation that did not produce it.
  assert.equal(renderJson(status).command, 'status');
  assert.equal(renderJson(plan).command, 'plan status');
});
