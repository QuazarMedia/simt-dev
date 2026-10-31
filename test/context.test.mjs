import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { repoContext } from '../src/context.mjs';
import { checkRepo } from '../src/commands/sync.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));

test('two reads of the same question share one computation', async () => {
  const ctx = repoContext(repo);
  const first = await ctx.fingerprint();
  const second = await ctx.fingerprint();
  assert.equal(first, second, 'the same object, so the second caller cost nothing');
  assert.deepEqual(ctx.stats, { hits: 1, misses: 1, entries: 1 });
});

test('two calls made before the first settles still compute once', async () => {
  const ctx = repoContext(repo);
  const [a, b] = await Promise.all([ctx.fingerprint(), ctx.fingerprint()]);
  assert.equal(a, b);
  assert.equal(ctx.stats.misses, 1, 'the second call awaited the pending one rather than starting a race');
});

test('each question is cached on its own, and a fresh context asks again', async () => {
  const ctx = repoContext(repo);
  await Promise.all([ctx.fingerprint(), ctx.manifest(), ctx.rules(), ctx.digest()]);
  assert.deepEqual(ctx.stats, { hits: 0, misses: 4, entries: 4 });
  const fresh = repoContext(repo);
  await fresh.manifest();
  assert.equal(fresh.stats.misses, 1, 'the cache is per run, never per process');
});

test('checkRepo reads through the context it is given', async () => {
  // The command used to call fingerprint twice and read the manifest twice in one run.
  // The assertion is on the cache's own counts rather than the clock, because a cache
  // that is wired but never hit looks exactly like a fast machine.
  const ctx = repoContext(repo);
  await checkRepo(repo, { ctx });
  assert.ok(ctx.stats.misses >= 2, 'the command asked the context for its reads');
  assert.ok(ctx.stats.hits >= 1, 'and asked it twice for the same thing');
});
