// A second value for a flag that is not repeatable (review 0003 Q62).
//
// `--root a --root b` resolved to `b` with no error: half of what the caller wrote was
// discarded, and the run answered a question they had overwritten without being told.
// A flag declared repeatable accumulates; every other one refuses the second value, and
// the message names the flags that do accumulate so the reader can act on it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parse, REPEATABLE_FLAGS } from '../src/argv.mjs';

test('a value flag given twice is a usage error, not a silent last-one-wins', () => {
  const result = parse(['--root', 'a', '--root', 'b']);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 2);
  assert.match(result.error.message, /--root was given twice/);
});

test('the refusal names a flag the caller can repeat instead of guessing', () => {
  const result = parse(['--paths', 'a', '--paths', 'b']);
  assert.equal(result.ok, false);
  for (const name of REPEATABLE_FLAGS) assert.match(result.error.message, new RegExp(`--${name}\\b`));
});

test('a repeatable flag accumulates, and a single value is still a list', () => {
  assert.deepEqual(parse(['--arm', 'a', '--arm', 'b']).value.flags.arm, ['a', 'b']);
  assert.deepEqual(parse(['--arm', 'a']).value.flags.arm, ['a']);
});

test('a flag the command does not take is named instead of silently ignored', async () => {
  // `status --frozen` ran, reported success and discarded the flag (review 0003 Q62).
  // One release names it on stderr; the next release makes it a usage error.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const bin = fileURLToPath(new URL('../bin/simt.mjs', import.meta.url));
  const result = await promisify(execFile)(process.execPath, [bin, 'status', '--line', '--frozen']).catch((e) => e);
  assert.match(String(result.stderr), /--frozen is not a flag of `status`/);
});

test('a flag the command does not take is carried in the JSON document too', async () => {
  // The note exists so a caller can act; a caller parsing stdout cannot see stderr, so
  // the same warning rides in the document (review 0003 Q62).
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const bin = fileURLToPath(new URL('../bin/simt.mjs', import.meta.url));
  // The window is closed: `--frozen` was tolerated until 0.9.0 and is now a usage error,
  // reported in the document a `--json` caller parses rather than only on stderr (ADR-014).
  const error = await promisify(execFile)(process.execPath, [bin, 'status', '--line', '--frozen', '--json'], { maxBuffer: 16 << 20 }).catch((e) => e);
  assert.equal(error.code, 2);
  const doc = JSON.parse(error.stdout);
  assert.equal(doc.ok, false);
  assert.match(JSON.stringify(doc), /--frozen is not a flag of `status`/);
});


test('a closed set refuses a value outside it, and names the alternatives', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const bin = fileURLToPath(new URL('../bin/simt.mjs', import.meta.url));
  const bad = await promisify(execFile)(process.execPath, [bin, 'map', '--level', 'bogus']).catch((e) => e);
  assert.match(String(bad.stderr), /--level takes outline, names, signatures; received bogus/);
});
