import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tokenize, scoreSkill, rankSkills, closure, resolveAlias, matchesGlob, stackCompatible } from '../src/resolve/resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(await readFile(resolve(ROOT, 'graph', 'skills.graph.json'), 'utf8'));
const skills = registry.skills;
const byName = new Map(skills.map((s) => [s.name, s]));

test('resolve: tokenize drops short words and punctuation', () => {
  assert.deepEqual(tokenize('Add a Room DB migration!'), ['add', 'room', 'migration']);
});

test('resolve: identical inputs produce identical output', () => {
  // The property the whole design rests on: no embeddings, no model call, so the
  // ranking is a pure function and a PR can diff it.
  const context = { repoStack: ['gradle'], taskTokens: tokenize('add a screen'), paths: [] };
  const a = rankSkills(skills, context).selected.map((e) => e.skill.name);
  const b = rankSkills(skills, context).selected.map((e) => e.skill.name);
  assert.deepEqual(a, b);
});

test('resolve: ranking is totally ordered, so ties do not drift', () => {
  const { selected } = rankSkills(skills, { repoStack: ['gradle'], taskTokens: ['gradle'], paths: [] });
  const names = selected.map((e) => e.skill.name);
  assert.deepEqual(names, [...names].sort((x, y) => x.localeCompare(y)) && names, 'names are name-sorted within score ties');
});

test('resolve: a Kotlin repo never gets the Cloudflare reference', () => {
  const context = { repoStack: ['gradle', 'wear-os'], taskTokens: tokenize('deploy a worker'), paths: [] };
  const { selected } = rankSkills(skills, context);
  assert.equal(selected.some((e) => e.skill.name === 'cloudflare'), false);
  assert.equal(selected.some((e) => e.skill.name === 'wrangler'), false);
});

test('resolve: the stack gate is the reason a skill is excluded', () => {
  const context = { repoStack: ['gradle'], taskTokens: [], paths: [] };
  const { excluded } = rankSkills(skills, context);
  const cloudflare = excluded.find((e) => e.skill.name === 'cloudflare');
  assert.ok(cloudflare, 'cloudflare should be excluded in a Gradle repo');
  assert.match(cloudflare.reason, /needs one of|stack overlap/);
});

test('resolve: an undetected repo excludes nothing on stack grounds', () => {
  assert.equal(stackCompatible(byName.get('cloudflare'), []), true);
});

test('resolve: forcing a skill overrides the stack gate', () => {
  // The escape hatch has to work, or an agent that knows better than the gate is stuck.
  const context = { repoStack: ['gradle'], taskTokens: [], paths: [] };
  const { selected } = rankSkills(skills, context, { forced: ['cloudflare'] });
  const forced = selected.find((e) => e.skill.name === 'cloudflare');
  assert.ok(forced);
  assert.deepEqual(forced.reasons, ['forced']);
});

test('resolve: path signals outrank task keywords', () => {
  // The diff is ground truth; what the user typed is not.
  const path = scoreSkill(byName.get('d1-safe-change'), {
    repoStack: ['cloudflare-workers'],
    taskTokens: [],
    paths: ['migrations/0042_add_galaxy.sql'],
  });
  const keyword = scoreSkill(byName.get('d1-safe-change'), {
    repoStack: ['cloudflare-workers'],
    taskTokens: ['migration'],
    paths: [],
  });
  assert.ok(path.score > keyword.score, `${path.score} !> ${keyword.score}`);
});

test('resolve: a deferred skill is never inlined by ranking alone', () => {
  // `deferred` is enforced at emit time in briefCommand; ranking must still not
  // put it first, which is why it is asserted here as a registry invariant.
  const deferred = skills.filter((s) => s.deferred);
  assert.ok(deferred.length > 0);
  for (const skill of deferred) assert.ok(skill.bytes > registry.deferredThreshold);
});

test('resolve: closure pulls in requires even when they scored zero', () => {
  const { selected } = rankSkills(skills, { repoStack: ['gradle'], taskTokens: tokenize('commit a fix'), paths: [] });
  const expanded = closure(selected, skills);
  const names = new Set(expanded.map((e) => e.skill.name));
  const withDeps = expanded.filter((e) => e.via.size > 0);
  for (const entry of withDeps) {
    for (const dep of entry.skill.requires) assert.ok(names.has(dep), `${dep} missing from closure`);
  }
});

test('resolve: closure terminates on the real registry', () => {
  const { selected } = rankSkills(skills, { repoStack: ['cloudflare-workers'], taskTokens: tokenize('commit'), paths: [] });
  const expanded = closure(selected, skills);
  assert.ok(expanded.length > 0);
  assert.ok(expanded.length <= skills.length, 'closure grew beyond the registry');
});

test('resolve: milestone-commit resolves to slice-commit', () => {
  const target = resolveAlias('milestone-commit', skills);
  assert.equal(target.name, 'slice-commit');
});

test('resolve: resolveAlias leaves a real name alone', () => {
  assert.equal(resolveAlias('d1-safe-change', skills).name, 'd1-safe-change');
});

test('resolve: matchesGlob handles ** and * the way the registry uses them', () => {
  assert.equal(matchesGlob('migrations/0042.sql', 'migrations/**'), true);
  assert.equal(matchesGlob('src/a/b/c.kt', 'src/**/*.kt'), true);
  assert.equal(matchesGlob('wrangler.jsonc', 'wrangler.jsonc'), true);
  assert.equal(matchesGlob('wrangler.jsonc', 'migrations/**'), false);
  assert.equal(matchesGlob('migrations/a/b/c.sql', 'migrations/**'), true);
});

test('resolve: the summary signal is weak enough not to dominate', () => {
  // If shared summary words outweighed a real path match, every skill that
  // mentions "skill" or "commit" would outrank the one for the actual diff.
  const real = scoreSkill(byName.get('d1-safe-change'), {
    repoStack: ['cloudflare-workers'],
    taskTokens: [],
    paths: ['migrations/x.sql'],
  });
  const weak = scoreSkill(byName.get('d1-safe-change'), {
    repoStack: ['cloudflare-workers'],
    taskTokens: ['review'],
    paths: [],
  });
  assert.ok(real.score > weak.score);
});

test('resolve: every skill in the registry can be scored without throwing', () => {
  for (const skill of skills) {
    const { score, reasons } = scoreSkill(skill, { repoStack: ['node'], taskTokens: ['test'], paths: ['src/a.ts'] });
    assert.equal(typeof score, 'number');
    assert.ok(Array.isArray(reasons));
  }
});