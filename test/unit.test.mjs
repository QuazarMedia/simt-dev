import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parse } from '../src/argv.mjs';
import { emit, emitJson, EXIT } from '../src/output/index.mjs';
import { fingerprint } from '../src/resolve/fingerprint.mjs';

test('argv: positional and boolean flags', () => {
  const { ok, value } = parse(['skills', 'brief', '--json']);
  assert.equal(ok, true);
  assert.deepEqual(value.positional, ['skills', 'brief']);
  assert.equal(value.flags.json, true);
});

test('argv: kebab flags are exposed as camelCase', () => {
  // Regression: --max-bytes used to be stored verbatim, so the output ceiling
  // silently did nothing. Flags are typed kebab-case, read as camelCase.
  const { value } = parse(['--max-bytes', '400', '--dry-run']);
  assert.equal(value.flags.maxBytes, 400);
  assert.equal(value.flags.dryRun, true);
});

test('argv: --no-<flag> sets false', () => {
  const { value } = parse(['--no-json']);
  assert.equal(value.flags.json, false);
});

test('argv: --key=value form', () => {
  const { value } = parse(['skills', 'brief', '--task=add a migration', '--budget=20480']);
  assert.equal(value.flags.task, 'add a migration');
  assert.equal(value.flags.budget, 20480);
});

test('argv: -- terminates flag parsing', () => {
  const { value } = parse(['doctor', '--', '--not-a-flag']);
  assert.deepEqual(value.positional, ['doctor', '--not-a-flag']);
  assert.equal(value.flags.notAFlag, undefined);
});

test('argv: unknown flags fail rather than being ignored', () => {
  // A typo'd gate name that is silently dropped is worse than one that fails.
  const { ok, code } = parse(['doctor', '--nope']);
  assert.equal(ok, false);
  assert.equal(code, EXIT.USAGE);
});

test('argv: non-negative integer flags are validated', () => {
  assert.equal(parse(['--max-bytes', '-1']).ok, false);
  assert.equal(parse(['--max-bytes', '1.5']).ok, false);
  assert.equal(parse(['--max-bytes', '0']).ok, true);
});

test('argv: value flags require a value', () => {
  assert.equal(parse(['--task']).ok, false);
  assert.equal(parse(['--task', '--json']).ok, false);
});

test('output: truncation is announced, never silent', () => {
  const chunks = [];
  const stream = { write: (s) => chunks.push(s) };
  const complete = emit('x'.repeat(100), { maxBytes: 0, stream });
  assert.equal(complete, true);
  assert.equal(chunks.join('').includes('TRUNCATED'), false);

  chunks.length = 0;
  const truncated = emit('x'.repeat(100), { maxBytes: 50, stream });
  assert.equal(truncated, false);
  const out = chunks.join('');
  // emit() appends the trailing newline, so the body is 101 bytes and 51 are
  // genuinely unwritten. The count must reflect real bytes, not the request.
  assert.match(out, /TRUNCATED 51 bytes omitted/);
});

test('output: --max-bytes never emits invalid JSON (Q10)', () => {
  // The old ceiling byte-cut the document: compact JSON has no newlines, so
  // `why --json --max-bytes 120` exited 0 with half a token on stdout. Arrays
  // shrink with a `truncated` record naming what lost how much instead.
  const chunks = [];
  const stream = { write: (s) => chunks.push(s) };
  const complete = emitJson({ ok: true, items: ['a', 'b', 'c'] }, { maxBytes: 0, stream });
  assert.equal(complete, true);
  assert.deepEqual(JSON.parse(chunks.join('')).items, ['a', 'b', 'c']);

  chunks.length = 0;
  const trimmed = emitJson({ ok: true, command: 'why', items: ['a'.repeat(40), 'b'.repeat(40)] }, { maxBytes: 120, stream });
  assert.equal(trimmed, false);
  const doc = JSON.parse(chunks.join(''));
  assert.deepEqual(doc.items, []);
  assert.equal(doc.truncated.field, 'items');
  assert.equal(doc.truncated.omitted, 2);
  assert.equal(doc.truncated.limit, 120);
});

test('output: a ceiling no trimming can fit is a MAX_BYTES envelope (Q10)', () => {
  // A payload of one long string has no array to shrink: the answer is an error
  // envelope that still parses, with the same remedy the text ceiling prints.
  const chunks = [];
  const stream = { write: (s) => chunks.push(s) };
  const complete = emitJson({ ok: true, command: 'why', blob: 'x'.repeat(500) }, { maxBytes: 120, stream });
  assert.equal(complete, false);
  const doc = JSON.parse(chunks.join(''));
  assert.equal(doc.ok, false);
  assert.equal(doc.command, 'why');
  assert.equal(doc.error.code, 'MAX_BYTES');
  assert.match(doc.error.remedy, /--max-bytes 0/);
  assert.equal(doc.truncated.limit, 120);
});

test('output: exit codes are stable', () => {
  // These values are a public contract: CI and agent callers branch on them.
  assert.deepEqual(
    { ok: EXIT.OK, fail: EXIT.FAIL, usage: EXIT.USAGE, config: EXIT.CONFIG, registry: EXIT.REGISTRY },
    { ok: 0, fail: 1, usage: 2, config: 3, registry: 4 },
  );
});

test('fingerprint: an unreadable root reports an error rather than throwing', async () => {
  const result = await fingerprint('/definitely/not/a/real/path');
  assert.equal(result.error, 'unreadable-root');
  assert.deepEqual(result.stack, []);
});

test('fingerprint: simt-dev itself classifies', async () => {
  const result = await fingerprint(new URL('..', import.meta.url).pathname);
  assert.ok(result.stack.includes('node'), `expected node in ${result.stack}`);
});

test('fingerprint: a .py script does not make a Gradle repo Python', async () => {
  // Regression: simt-app carries Python tooling scripts inside a Gradle project
  // and was tagged `python`. Marker files are required for the python tag.
  const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'simt-fp-'));
  await writeFile(join(root, 'build.gradle.kts'), '');
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts', 'tool.py'), '');
  const result = await fingerprint(root);
  assert.equal(result.stack.includes('python'), false, result.stack.join(','));
  assert.equal(result.stack.includes('gradle'), true);
});
