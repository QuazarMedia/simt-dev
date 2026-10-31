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
