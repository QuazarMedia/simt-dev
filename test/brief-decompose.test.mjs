import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decomposePrompt, MAX_SUBTASKS } from '../src/brief/decompose.mjs';

const clauses = (prompt) => decomposePrompt(prompt).map(({ text }) => text);

test('splits both research probes into four clauses with stable original offsets', () => {
  const mixed = 'Fix the BM25 ranking in map.mjs, add multi-task decomposition to brief, update impact to handle symbol call sites, and fix a typo in README.md';
  assert.deepEqual(clauses(mixed), [
    'Fix the BM25 ranking in map.mjs',
    'add multi-task decomposition to brief',
    'update impact to handle symbol call sites',
    'fix a typo in README.md',
  ]);
  const composite = 'Refactor the authentication middleware to support refresh token rotation, add unit tests for expired sessions, migrate database schema for audit logs, and document the new rate limits in the API guide';
  assert.equal(decomposePrompt(composite).length, 4);
  for (const { clauses: parts } of decomposePrompt(mixed)) {
    for (const { text, start, end } of parts) assert.equal(mixed.slice(start, end), text);
  }
});

test('keeps noun conjunctions, guarded clauses, and punctuation inside protected text', () => {
  for (const prompt of [
    'Fix login and signup validation in auth.ts',
    'Update foo.mjs and bar.mjs',
    'Update the retry and timeout behavior; leave the endpoints alone.',
    'Only when the process has stopped, update the output.',
    'Verify the text "keep, update, and fix" in the fixture.',
    'Validate the regex /fix, add|and update/ and record the result.',
  ]) {
    assert.deepEqual(clauses(prompt), [prompt], prompt);
  }
  const guarded = decomposePrompt('If the option is active, update auth.ts; then verify the output.');
  assert.equal(guarded.length, 2);
  assert.match(guarded[0].text, /^If the option is active, update auth\.ts/u);
  assert.equal(guarded[1].clauses[0].sequence, 'then');

  const code = 'Review \x60fix, and add\x60 in https://example.org/a.b?q=update, and update src/labels/route[v2].mjs';
  assert.deepEqual(clauses(code), [
    'Review \x60fix, and add\x60 in https://example.org/a.b?q=update',
    'update src/labels/route[v2].mjs',
  ]);
});

test('uses Markdown structure, scopes, checkboxes and protected multiline fences', () => {
  const prompt = [
    'In the auth service:',
    '',
    '## Session work',
    '### Task 1',
    '- [ ] Fix login',
    '  \x60\x60\x60js',
    '  // do not start another task.',
    '',
    '  // then add fake content',
    '  \x60\x60\x60',
    '2) Document retries',
    '',
    '## Storage',
    '• Migrate the session table',
    '',
    'We should verify the output. Then report the result.',
  ].join('\n');
  const result = decomposePrompt(prompt);
  assert.equal(result.length, 5);
  assert.deepEqual(result.map(({ context }) => context), [
    ['In the auth service', 'Session work'],
    ['In the auth service', 'Session work'],
    ['In the auth service', 'Storage'],
    ['In the auth service', 'Storage'],
    ['In the auth service', 'Storage'],
  ]);
  assert.match(result[0].text, /then add fake content/u);
  assert.equal(result.at(-1).clauses[0].sequence, 'then');
});

test('keeps all clause IDs and original contexts when a list exceeds the cap', () => {
  const prompt = [
    'In the auth service:',
    ...Array.from({ length: 20 }, (_, i) => '- Update src/' + (i < 10 ? 'auth' : 'shared') + '/file-' + i + '.mjs'),
  ].join('\n');
  const result = decomposePrompt(prompt);
  assert.equal(result.length, MAX_SUBTASKS);
  assert.deepEqual(result.flatMap(({ clauseIds }) => clauseIds), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.ok(result.every(({ context }) => context[0] === 'In the auth service'));
  assert.ok(!result.some(({ text }) => text.includes('/auth/') && text.includes('/shared/')));
  assert.deepEqual(result, decomposePrompt(prompt));
  assert.deepEqual(decomposePrompt('   '), []);
});
