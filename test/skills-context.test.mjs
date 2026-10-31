import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { repoContext } from '../src/context.mjs';
import { skillsBriefFacts, skillsWhyFacts } from '../src/commands/skills.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));

test('two skills reads in one run share the fingerprint', async () => {
  // `why` asks the registry first and the repository second: on a miss the skill lookup
  // fingerprints, and so does the signal chain. One context makes that one walk.
  const ctx = repoContext(repo);
  await skillsBriefFacts(repo, { ctx, task: 'review a diff' });
  const afterBrief = ctx.stats.misses;
  await skillsWhyFacts(repo, 'review', { ctx, task: 'review a diff' }).catch(() => null);
  assert.equal(ctx.stats.misses, afterBrief, 'the second read started no new computation');
  assert.ok(ctx.stats.hits >= 1, 'and it was answered from the first');
});

test('without a context each call still answers on its own', async () => {
  // The optional context is an optimisation, never a requirement: a caller that passes
  // nothing must get the same facts.
  const facts = await skillsBriefFacts(repo, { task: 'review a diff' });
  assert.equal(typeof facts, 'object');
  assert.ok(Array.isArray(facts.shown));
});
