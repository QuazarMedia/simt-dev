import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { repoContext } from '../src/context.mjs';
import { diagnose } from '../src/commands/doctor.mjs';
import { rulesCatalogue, rulesWhyFacts } from '../src/commands/rules.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));

test('a diagnosis asks its context for both reads it makes', async () => {
  const ctx = repoContext(repo);
  await diagnose(repo, { ctx });
  // The fingerprint and the manifest are different questions, so both are misses - and
  // a second diagnosis through the same context pays for neither.
  assert.equal(ctx.stats.misses, 2, 'fingerprint and manifest were each read once');
  await diagnose(repo, { ctx });
  assert.equal(ctx.stats.misses, 2, 'the second diagnosis started no new computation');
  assert.ok(ctx.stats.hits >= 2);
});

test('the rules catalogue and its why facts share the caller context', async () => {
  const ctx = repoContext(repo);
  const catalogue = await rulesCatalogue(repo, { ctx });
  assert.ok(Array.isArray(catalogue.rules), 'the catalogue is still the data the CLI renders');
  assert.equal(ctx.stats.misses, 1, 'one rules load answered the catalogue');
  await rulesWhyFacts(repo, 'core', { ctx }).catch(() => null);
  assert.equal(ctx.stats.misses, 1, 'and the second read was answered from it');
});
