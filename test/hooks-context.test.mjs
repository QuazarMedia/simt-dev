import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { repoContext } from '../src/context.mjs';
import { planHooksInstall } from '../src/commands/hooks.mjs';
import { readManifest } from '../src/projection/manifest.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));

test('the install plan reads its repository through the caller context', async () => {
  const { manifest, exists } = await readManifest(repo);
  const ctx = repoContext(repo);
  await planHooksInstall(repo, { manifest, exists }, ctx);
  // This repository has a package.json, so the plan resolves the node runner from the
  // fingerprint. Passing a context must make that read shared rather than new.
  assert.ok(ctx.stats.misses >= 1, 'the plan asked the context');
  const afterFirst = ctx.stats.misses;
  await planHooksInstall(repo, { manifest, exists }, ctx);
  assert.equal(ctx.stats.misses, afterFirst, 'and a second plan started no new computation');
});

test('a plan without a context still answers, through the light import', async () => {
  // The hook path must not load the fingerprint module just by importing hooks.mjs, so
  // the no-context path keeps its dynamic import rather than a static one.
  const { manifest, exists } = await readManifest(repo);
  const planned = await planHooksInstall(repo, { manifest, exists });
  assert.ok(planned && typeof planned === 'object', 'the plan is still a plan');
  assert.ok(Object.values(planned).some(Array.isArray), 'and it still carries the files it would write');
});
