// A09: `applies()` trusted `parsed === true` and never fell back to the regex, so a
// command that tokenised but produced no git fact - a wrapper such as `busybox git push`
// or `docker run alpine git push` - matched no policy at all. The push row's regex
// already denied the parse-failure path; this is the same evidence, one branch over.
//
// A new file because test/agenthooks.test.mjs is 982 lines, and the lane that follows
// A09 appends here rather than pushing that file over the hard ceiling.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decide } from '../src/agenthooks/decide.mjs';

/** Facts as the normaliser leaves a command that parsed but carried no git fact. */
const parsedWithoutGit = (command) => ({
  command,
  shell: { parsed: true, facts: [] },
  writes: [],
});

test('a parsed command with no git fact still meets the push regex (A09)', () => {
  for (const command of ['busybox git push origin main', 'docker run alpine git push']) {
    const decision = decide({ facts: parsedWithoutGit(command), env: {} });
    assert.equal(decision.decision, 'deny', `${command} was allowed`);
    assert.ok(decision.blocked.includes('push'), `${command} did not match the push row`);
  }
});

test('the fallback does not deny a command the regex does not name (A09)', () => {
  const decision = decide({ facts: parsedWithoutGit('busybox ls -la'), env: {} });
  assert.equal(decision.decision, 'allow');
});
