// Review 0003 Q81: one `why`, and the subject decides which answer a reader gets.
//
// The classifier is a table over a token and a corpus, so these tests supply their own
// corpus. A test that read this checkout's rules or registry would pass here and mean
// nothing in a repository with different names (ADR-031).

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifySubject } from '../src/commands/why.mjs';

const CORPUS = { ruleIds: new Set(['core', 'cloudflare-workers']), skillNames: new Set(['wrangler', 'simt-commands']) };

test('a bare token names its own kind when only one kind carries it', () => {
  assert.deepEqual(classifySubject('core', CORPUS), { kind: 'rule', value: 'core' });
  assert.deepEqual(classifySubject('wrangler', CORPUS), { kind: 'skill', value: 'wrangler' });
});

test('a name both kinds carry is an error that names the prefixes, and a prefix settles it', () => {
  const both = { ruleIds: new Set(['shared']), skillNames: new Set(['shared']) };
  assert.deepEqual(classifySubject('rule:shared', both), { kind: 'rule', value: 'shared' });
  assert.deepEqual(classifySubject('skill:shared', both), { kind: 'skill', value: 'shared' });
  const ambiguous = classifySubject('shared', both);
  assert.match(ambiguous.error, /names a rule and a skill/);
  assert.match(ambiguous.remedy, /rule:shared/);
  assert.match(ambiguous.remedy, /skill:shared/);
});

test('a path, a decision and a finding code are recognised without the corpus', () => {
  const files = new Set(['AGENTS.md', 'src/commands/why.mjs']);
  assert.deepEqual(classifySubject('AGENTS.md', { files }), { kind: 'path', value: 'AGENTS.md' });
  assert.deepEqual(classifySubject('src/commands/why.mjs', { files }), { kind: 'path', value: 'src/commands/why.mjs' });
  assert.deepEqual(classifySubject('adr-093', {}), { kind: 'adr', value: 'ADR-093' });
  assert.deepEqual(classifySubject('BEYOND-READ-LIMIT', {}), { kind: 'finding', value: 'BEYOND-READ-LIMIT' });
});

test('a lower-case hyphenated name is a rule id, not a finding code', () => {
  // The finding shape is upper case on purpose: `cloudflare-workers` is a rule, and a
  // case-insensitive match would send it to `explain` and report an unknown code.
  for (const token of ['cloudflare-workers', 'durable-objects']) {
    const rule = classifySubject(token, { ruleIds: new Set([token]) });
    assert.equal(rule.error, undefined, `${token} was not classified as a rule`);
    assert.equal(rule.kind, 'rule');
  }
});

test('an unknown subject is a usage error naming every kind it accepts', () => {
  const miss = classifySubject('nothing-here', {});
  assert.match(miss.error, /no such subject/);
  assert.match(miss.remedy, /ADR-NNN/);
  assert.match(miss.remedy, /rule:<id>/);
  assert.match(miss.remedy, /skill:<name>/);
});

test('a prefixed name that does not exist is refused with the command that lists them', () => {
  const rule = classifySubject('rule:nope', CORPUS);
  assert.match(rule.error, /unknown rule/);
  assert.match(rule.remedy, /rules list/);
  const skill = classifySubject('skill:nope', CORPUS);
  assert.match(skill.error, /unknown skill/);
  assert.match(skill.remedy, /skills find/);
  assert.match(classifySubject('rule:', CORPUS).error, /needs a name/);
  assert.match(classifySubject('', CORPUS).error, /needs a subject/);
});
