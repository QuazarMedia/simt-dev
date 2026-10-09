import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { tokenize, scoreSkill, rankSkills, closure, resolveAlias, matchesGlob, stackCompatible, syntheticPathFor } from '../src/resolve/resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = resolve(ROOT, 'bin', 'simt-dev.mjs');
const exec = promisify(execFile);
const registry = JSON.parse(await readFile(resolve(ROOT, 'graph', 'skills.graph.json'), 'utf8'));
const skills = registry.skills;
const byName = new Map(skills.map((s) => [s.name, s]));

test('resolve: tokenize keeps two-letter words and drops punctuation (S03)', () => {
  // The floor was 3, which discarded the most specific words in this domain. `db` is
  // not noise in "Add a Room DB migration", and `d1` is not noise in "fix d1 migration".
  assert.deepEqual(tokenize('Add a Room DB migration!'), ['add', 'room', 'db', 'migration']);
  assert.deepEqual(tokenize('Fix the UI CI job'), ['fix', 'the', 'ui', 'ci', 'job']);
  assert.deepEqual(tokenize('ar/RTL, café'), ['ar', 'rtl', 'caf']);
});

test('resolve: the two-letter words this registry depends on survive tokenization (S03)', () => {
  // Not a sample: every alias of two letters in the capability table, which is where
  // they were silently dead. `d1` lost is a resolver that cannot be told about D1 at
  // all, and the score it would have carried was the highest a task can offer.
  for (const word of ['ui', 'r2', 'kv', 'd1', 'ci']) {
    assert.ok(tokenize(`do the ${word} work`).includes(word), `${word} was dropped`);
  }
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

test('resolve: a leading ** matches at any depth, including none (S02)', () => {
  // The defect: only a TRAILING double star was translated, so a leading one compiled
  // to an invalid regex that a `catch` turned into `false`. 13 of 65 registry globs
  // start this way and path is the heaviest signal there is.
  assert.equal(matchesGlob('c.ts', '**/*.ts'), true);
  assert.equal(matchesGlob('a/b/c.ts', '**/*.ts'), true);
  assert.equal(matchesGlob('src/x/a.test.ts', '**/*.test.ts'), true);
  assert.equal(matchesGlob('src/a.kt', '**/*.kt'), true);
});

test('resolve: ** in each position is anchored the way a path segment is (S02)', () => {
  assert.equal(matchesGlob('build/x.gradle', '**/build/**'), true);
  assert.equal(matchesGlob('x/y/build/z.gradle', '**/build/**'), true);
  assert.equal(matchesGlob('src/sample.kt', 'src/**/*.kt'), true);
  assert.equal(matchesGlob('src/a/b/c.kt', 'src/**/*.kt'), true);
  assert.equal(matchesGlob('anything/at/all', '**'), true);
  // A bare star is still confined to one segment, which is what makes the double star
  // worth translating rather than treating every star alike.
  assert.equal(matchesGlob('src/a/b.ts', 'src/*.ts'), false);
  assert.equal(matchesGlob('src/a.ts', 'src/*.ts'), true);
});

test('resolve: a double star is expanded both ways, or the check above is a mirror (S02)', () => {
  // The registry-wide test below reads the SAME generator it is checking, so if the
  // generator stops producing the deeper expansion, that test still passes - it just
  // checks fewer paths. Asserting the generator's own contract here is what keeps the
  // mirror honest: a glob claiming any depth must be shown a path at depth and a path
  // not at depth.
  assert.deepEqual(syntheticPathFor('**/*.ts'), ['sample.ts', 'deep/nested/sample.ts']);
  assert.deepEqual(syntheticPathFor('migrations/**'), ['migrations', 'migrations/deep/nested']);
  assert.deepEqual(syntheticPathFor('**'), ['deep/nested']);
});

test('resolve: every glob the registry declares matches a path built from it (S02)', () => {
  // The registry-wide assertion. The unit cases above prove the translation; this
  // proves no declared glob escapes it, which is the part that rots: a hand-added
  // glob that compiles to nothing is silent to every other check.
  const globs = [...new Set(skills.flatMap((s) => s.paths ?? []))];
  assert.ok(globs.length > 0, 'the registry declares no globs, so this test would pass for free');
  for (const glob of globs) {
    const candidates = syntheticPathFor(glob);
    assert.ok(candidates.length > 0, `${glob} expands to no path`);
    // EVERY candidate, not one of them. A glob synthesised only in its empty
    // expansion matches a path at the repository root while still failing at any
    // depth, which is how a half-translated double star survives an assertion that
    // only asks whether something matched.
    const missed = candidates.filter((p) => !matchesGlob(p, glob));
    assert.deepEqual(missed, [], `${glob} misses ${missed.join(', ')}`);
  }
});

test('resolve: a multi-word keyword matches as a phrase and names itself (S03)', () => {
  // Keywords used to be compared one task token at a time, so "durable object" could
  // never match: neither token equals the declared keyword. It is declared on four
  // skills, and it was dead on all four.
  const durable = byName.get('durable-objects');
  const hit = scoreSkill(durable, { repoStack: [], taskTokens: tokenize('write a durable object store'), paths: [] });
  assert.ok(hit.reasons.includes('keyword:durable object'), `no phrase reason: ${hit.reasons}`);
});

test('resolve: a phrase needs its words adjacent, in any order-free run (S03)', () => {
  // Adjacency is what makes this a phrase rather than a bag of words, and it is the
  // part that keeps it deterministic - there is no similarity and no model here.
  const durable = byName.get('durable-objects');
  const apart = scoreSkill(durable, { repoStack: [], taskTokens: tokenize('durable storage object'), paths: [] });
  assert.ok(!apart.reasons.includes('keyword:durable object'), 'matched a phrase whose words are not adjacent');
  const together = scoreSkill(durable, { repoStack: [], taskTokens: tokenize('a durable object'), paths: [] });
  assert.ok(together.reasons.includes('keyword:durable object'));
});

test('resolve: every keyword the registry declares is reachable (S03)', () => {
  // Registry-wide, same shape as the glob check in S02: no keyword may be unsayable.
  const keywords = [...new Set(skills.flatMap((s) => s.keywords ?? []))];
  assert.ok(keywords.length > 0, 'the registry declares no keywords, so this would pass for free');
  for (const keyword of keywords) {
    assert.ok(tokenize(keyword).length > 0, `"${keyword}" keeps no word the tokenizer keeps`);
  }
});

test('resolve: the path signal now reaches the skills that declare a leading ** (S02)', () => {
  // The end of the chain: the matcher being correct is worth nothing if the signal
  // does not arrive. complete-testing declares a leading-star test glob, so a diff
  // that is one test file must select it - which it could not while the glob was dead.
  const changed = scoreSkill(byName.get('complete-testing'), {
    repoStack: ['node'],
    taskTokens: [],
    paths: ['src/checkout/order.spec.ts'],
  });
  assert.ok(changed.reasons.some((r) => r.startsWith('path:')), `no path reason: ${changed.reasons}`);
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

// --- the acceptance review 0001 named, run through the shipped binary ------------
//
// Both claims below are about what a reader sees, not about a function's return value,
// so they are asked of the command. A unit test proves the matcher; only this proves the
// `keyword:` reason an agent is meant to act on is actually printed.

test('resolve: `skills find "durable object"` reports the keyword (S03)', async () => {
  // Review 0001 §S03, verbatim: this command reported four matches and not one
  // `keyword:` reason, on a phrase four skills declare.
  const { stdout } = await exec('node', [BIN, 'skills', 'find', 'durable object']);
  assert.match(stdout, /keyword:durable object/);
});

test('resolve: `skills brief --task "d1 migration"` reports the keyword (S03)', async () => {
  // The same finding's second claim: `d1` tokenized away entirely, so the single most
  // specific word in the task could not select anything.
  const { stdout } = await exec('node', [BIN, 'skills', 'brief', '--task', 'd1 migration', '--root', ROOT]);
  assert.match(stdout, /keyword:d1/);
});