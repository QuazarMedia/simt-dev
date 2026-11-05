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

/** A normalised git fact, as `parseGit` leaves one. */
const gitFact = (over = {}) => ({
  kind: 'git',
  sub: 'pull',
  opts: new Set(['r']),
  refspecs: [],
  globals: { c: [] },
  ...over,
});

const parsedGit = (command, facts) => ({ command, shell: { parsed: true, facts }, writes: [] });

test('git pull -r is treated as the rewrite it is (A10)', () => {
  const denied = decide({ facts: parsedGit('git pull -r origin main', [gitFact()]), env: {} });
  assert.equal(denied.decision, 'deny');
  assert.ok(denied.blocked.includes('rewrite'), 'the short rebase flag was not read');

  const allowed = decide({ facts: parsedGit('git pull origin main', [gitFact({ opts: new Set() })]), env: {} });
  assert.equal(allowed.decision, 'allow', 'a plain pull is not a rewrite');
});

/** Facts as an unbalanced quote leaves them: no parse, so only the text is evidence. */
const unparsed = (command) => ({ command, shell: { parsed: false, facts: [] }, writes: [] });

test('an unparseable command that names the hooks path is denied (A23)', () => {
  for (const command of ['git config core.hooksPath /dev/null "unclosed', 'rm -rf .simt/hooks "unclosed']) {
    const decision = decide({ facts: unparsed(command), env: {} });
    assert.equal(decision.decision, 'deny', `${command} was allowed`);
    assert.ok(decision.blocked.includes('hooks-disable'), `${command} did not match the hooks row`);
  }

  // The fallback is this row's text, not a general pattern match.
  assert.equal(decide({ facts: unparsed('echo "unclosed'), env: {} }).decision, 'allow');
});

test('a parseable git config core.hooksPath stays denied (A23)', () => {
  const facts = parsedGit('git config core.hooksPath /dev/null', [
    gitFact({ sub: 'config', opts: new Set(), refspecs: ['core.hooksPath', '/dev/null'] }),
  ]);
  const decision = decide({ facts, env: {} });
  assert.equal(decision.decision, 'deny');
  assert.ok(decision.blocked.includes('hooks-disable'));
});
