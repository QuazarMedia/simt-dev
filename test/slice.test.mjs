// `simt slice` (review 0003 Q92).
//
// `commands/slice.mjs` drives three states of one worktree - start, finish, abandon - and it
// had no direct test: the slice suite reached it through the binary, so what it refuses
// before touching git was never pinned. That ordering is the contract worth testing: a usage
// error must arrive before a worktree exists, because the alternative is a branch nobody can
// brief and a row still waiting.
//
// The cases here are the ones a caller gets wrong, and each asserts the refusal rather than
// the success path the command suite already covers.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sliceCommand } from '../src/commands/slice.mjs';
import { capture, tempDir } from './fixture.mjs';

test('every subcommand that needs an id refuses without one, and says what to run', async () => {
  const root = await tempDir('slice-');
  for (const sub of ['start', 'finish', 'abandon']) {
    const result = await capture(() => sliceCommand(sub, [], { root }));
    assert.notEqual(result.code, 0, `${sub} accepted no id`);
    assert.match(result.stderr, new RegExp(`slice ${sub} needs a slice id`), sub);
    assert.match(result.stderr, /run: simt plan next/, sub);
  }
});

test('prompt mode without a prompt is a usage error, not a slice named after nothing', async () => {
  const root = await tempDir('slice-');
  const result = await capture(() => sliceCommand('start', [], { root, dashdash: true }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /needs a prompt after --/);
});

test('an unknown subcommand names the three that exist instead of guessing one', async () => {
  const root = await tempDir('slice-');
  const result = await capture(() => sliceCommand('squash', ['Q1'], { root }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unknown slice subcommand squash/);
  assert.match(result.stderr, /slice start <id> {2}\| {2}simt slice finish <id>/);
});
