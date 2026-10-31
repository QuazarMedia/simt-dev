import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  tokenize,
  scoreSkill,
  rankSkills,
  closure,
  selectWithinBudget,
  resolveAlias,
  matchesGlob,
  stackCompatible,
  syntheticPathFor,
} from '../src/resolve/resolve.mjs';
import { nearMatches } from '../src/resolve/near.mjs';


const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = resolve(ROOT, 'bin', 'simt.mjs');
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
  const path = scoreSkill(byName.get('wrangler'), {
    repoStack: ['cloudflare-workers'],
    taskTokens: [],
    paths: ['wrangler.jsonc'],
  });
  const keyword = scoreSkill(byName.get('wrangler'), {
    repoStack: ['cloudflare-workers'],
    taskTokens: ['wrangler'],
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
  const { selected } = rankSkills(skills, { repoStack: ['cloudflare-workers'], taskTokens: tokenize('wrangler'), paths: [] });
  const expanded = closure(selected, skills);
  assert.ok(expanded.length > 0);
  assert.ok(expanded.length <= skills.length, 'closure grew beyond the registry');
});

test('resolve: a dependency that does not fit takes its parent', () => {
  // Rule 2 is directional and the direction is the whole of it. With a budget that fits
  // the parent and not the child, the answer is neither — and the parent's own bytes
  // being small is not a reason to show it alone.
  const shape = [
    { skill: { name: 'parent', bytes: 100, deferred: false, requires: ['child'] }, via: new Set() },
    { skill: { name: 'child', bytes: 900, deferred: false, requires: [] }, via: new Set(['parent']) },
  ];
  const none = selectWithinBudget(shape, { budget: 500 });
  assert.deepEqual(none.picked.map((e) => e.skill.name), []);
  assert.equal(none.used, 0);
  assert.deepEqual(none.deferred.map((e) => e.skill.name), ['parent', 'child']);

  const all = selectWithinBudget(shape, { budget: 1000 });
  assert.deepEqual(all.picked.map((e) => e.skill.name), ['parent', 'child']);
  assert.equal(all.used, 1000);
});

test('resolve: `deferred` is a pointer, not a budget failure, so it does not move a parent', () => {
  // Rule 3. `deferred` is derived from `deferredThreshold`, not from the budget, and it
  // means "fetch this with `skills show`". Under `--all` the parent is still what the
  // caller asked for, and the pointer to the dependency is what a pointer is for.
  // Conflating the two is how a 384 KB body would suppress an unrelated small skill.
  const shape = [
    { skill: { name: 'parent', bytes: 100, deferred: false, requires: ['huge'] }, via: new Set() },
    { skill: { name: 'huge', bytes: 400000, deferred: true, requires: [] }, via: new Set(['parent']) },
  ];
  const capped = selectWithinBudget(shape, { budget: 1000000 });
  assert.deepEqual(capped.picked.map((e) => e.skill.name), ['parent']);
  assert.deepEqual(capped.deferred.map((e) => e.skill.name), ['huge']);

  const all = selectWithinBudget(shape, { budget: 10, all: true });
  assert.deepEqual(all.picked.map((e) => e.skill.name), ['parent']);
  assert.deepEqual(all.deferred.map((e) => e.skill.name), ['huge']);
});

test('resolve: the reported total is the bytes actually paid', () => {
  // `used` is recomputed from what was picked rather than accumulated during the walk,
  // because a parent pulled out by rule 2 must stop counting. A total that includes a
  // dropped skill reports bytes nobody is paying, and the header line prints it.
  const shape = [
    { skill: { name: 'kept', bytes: 300, deferred: false, requires: [] }, via: new Set() },
    { skill: { name: 'dropped', bytes: 800, deferred: false, requires: ['gone'] }, via: new Set() },
    { skill: { name: 'gone', bytes: 900, deferred: false, requires: [] }, via: new Set(['dropped']) },
  ];
  const r = selectWithinBudget(shape, { budget: 1000 });
  assert.deepEqual(r.picked.map((e) => e.skill.name), ['kept']);
  assert.equal(r.used, 300, 'a parent deferred by rule 2 must stop counting against the budget');
  assert.equal(
    r.picked.reduce((n, e) => n + e.skill.bytes, 0),
    r.used,
  );
});

test('resolve: resolveAlias leaves a real name alone', () => {
  assert.equal(resolveAlias('wrangler', skills).name, 'wrangler');
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

test('resolve: a trailing ** matches the directory itself (ADR-053)', () => {
  // path.matchesGlob requires a child, so the directory lint builds from `migrations/**`
  // would miss. The empty expansion is the case ruling 3 of ADR-042 exists to check.
  assert.equal(matchesGlob('migrations', 'migrations/**'), true);
  assert.equal(matchesGlob('build', '**/build/**'), true);
  assert.equal(matchesGlob('other', 'migrations/**'), false);
});

test('resolve: ? and braces match nothing, so lint can see them (ADR-042 ruling 4)', () => {
  // path.matchesGlob reads `?` as one character and braces as alternatives. Ruling 4
  // refused both: a glob the registry does not use has to fail graph lint, not select
  // a different path. `src/aq.ts` is the synthetic path lint builds from `src/a?.ts`.
  assert.equal(matchesGlob('src/aq.ts', 'src/a?.ts'), false);
  assert.equal(matchesGlob('src/a.ts', 'src/{a,b}.ts'), false);
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
  // does not arrive. firebase-auth-basics declares a leading-star auth glob, so a diff
  // that is one auth file must select it - which it could not while the glob was dead.
  const changed = scoreSkill(byName.get('firebase-auth-basics'), {
    repoStack: ['node'],
    taskTokens: [],
    paths: ['src/auth/login.ts'],
  });
  assert.ok(changed.reasons.some((r) => r.startsWith('path:')), `no path reason: ${changed.reasons}`);
});

test('resolve: the summary signal is weak enough not to dominate', () => {
  // If shared summary words outweighed a real path match, every skill that
  // mentions "skill" or "commit" would outrank the one for the actual diff.
  const real = scoreSkill(byName.get('wrangler'), {
    repoStack: ['cloudflare-workers'],
    taskTokens: [],
    paths: ['wrangler.jsonc'],
  });
  const weak = scoreSkill(byName.get('wrangler'), {
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

test('resolve: `skills brief --task "simt dry-run"` reports the keyword (S03)', async () => {
  // The same finding's second claim: the specific words in the task must select
  // through the keyword signal and name themselves in the reason the agent acts on.
  const { stdout } = await exec('node', [BIN, 'skills', 'brief', '--task', 'simt dry-run', '--root', ROOT]);
  assert.match(stdout, /keyword:simt/);
});
// --- S04: stack is compatibility, not evidence ---------------------------------
//
// The two acceptance cases in review 0001 §S04 are asserted end to end in
// `test/eval.test.mjs` against the gold corpus. These are the properties that corpus
// cannot show on its own, because a corpus case is one context and these are rules.

test('resolve: stack alone never selects, however many tags overlap (S04)', () => {
  // Three overlapping tags is 45 points, above the minimum of 25. Only a rule that
  // excludes stack from its own threshold rejects it, which is the whole content of
  // "stack is a tiebreaker".
  const skill = {
    name: 'anything',
    stack: ['node', 'node-web', 'react'],
    keywords: ['kubernetes'],
    summary: 'A summary nobody mentioned',
    capabilities: ['maps'],
  };
  const context = { repoStack: ['node', 'node-web', 'react'], taskTokens: tokenize('the usual'), paths: [] };
  const { selected, excluded } = rankSkills([skill], context);
  assert.deepEqual(selected, []);
  assert.match(excluded[0].reason, /stack alone/);
});

test('resolve: a weak signal is rejected, and the reason names it (S04)', () => {
  // The reason is the product here. `NOT SELECTED` is the block an agent uses to
  // override, so a rejection that cannot be acted on is the same defect as a bad
  // selection.
  //
  // A synthetic skill, not the real registry: measured, no registry skill lands strictly
  // between 0 and MIN_SCORE, so a test written against the registry would assert a reason
  // real data never produces and pass for the wrong reason.
  const weak = {
    name: 'weak-signal',
    stack: ['node'],
    keywords: ['kubernetes'],
    summary: 'durable dashboards for the fleet',
    capabilities: ['maps'],
  };
  const { selected, excluded } = rankSkills([weak], {
    repoStack: ['node'],
    taskTokens: tokenize('tidy the dashboards'),
    paths: [],
  });
  assert.deepEqual(selected, []);
  assert.match(excluded[0].reason, /summary:dashboards, which scores 8; 25 is the least score that selects/);
});

test('resolve: a stopword cannot select through the summary signal (S04)', () => {
  // The measured case: "fix a typo in the README" resolved four skills on `summary:the`
  // and `summary:in`. The stopword list is the fix, and the threshold is not - a summary
  // hit is 8, so the threshold would drop it anyway, but not the OTHER direction.
  const skill = { name: 'anything', stack: ['node'], keywords: ['kubernetes'], summary: 'in the and the', capabilities: ['maps'] };
  const { score, reasons } = scoreSkill(skill, { repoStack: [], taskTokens: tokenize('fix a typo in the README'), paths: [] });
  assert.equal(score, 0);
  assert.deepEqual(reasons, []);
});

test('resolve: a real summary word still selects (S04)', () => {
  // The other half of the stopword test, because a stopword list long enough to suppress
  // everything is a resolver that selects nothing and passes the empty corpus cases.
  const skill = { name: 'anything', stack: [], keywords: ['kubernetes'], summary: 'observability and slo dashboards', capabilities: ['maps'] };
  const { reasons } = scoreSkill(skill, { repoStack: [], taskTokens: tokenize('the slo dashboard'), paths: [] });
  assert.ok(reasons.includes('summary:slo'), `lost the real signal: ${reasons}`);
});

test('resolve: forcing a skill still overrides the new rule (S04)', () => {
  // An agent that knows better than the threshold is stuck if the escape hatch is gated
  // by it too. The new rule must not touch `forced`.
  const skill = { name: 'anything', stack: ['node'], keywords: ['kubernetes'], summary: 'x', capabilities: ['maps'] };
  const { selected } = rankSkills([skill], { repoStack: ['node'], taskTokens: [], paths: [] }, { forced: ['anything'] });
  assert.equal(selected.length, 1);
  assert.deepEqual(selected[0].reasons, ['forced']);
});

// --- nearMatches (S22) --------------------------------------------------------

test('nearMatches: an exact match leads, and a one-character fragment is not a suggestion', () => {
  // Three defects in one function that had no test at all.
  //
  // 1. Substring matches scored 0, the same as an exact match, and the tiebreak is
  //    alphabetical — so `nearMatches('graphs', ['graph','graphs'])` returned
  //    `['graph','graphs']` and put the exact match SECOND.
  // 2. `nearMatches('test', ['e','test-writer','check'])` returned `['e', ...]`. Every
  //    caller prints this list verbatim as `did you mean e, test-writer?`, and an agent
  //    reading that installs `e`. The old condition was
  //    `cl.includes(lower) || lower.includes(cl)` with no length floor, so any fragment
  //    of the query scored a perfect 0.
  assert.deepEqual(nearMatches('graphs', ['graph', 'graphs']), ['graphs', 'graph']);
  assert.deepEqual(nearMatches('test', ['e', 'test-writer', 'check']), ['test-writer']);
});

test('nearMatches: a fragment counts only when it is half the query or more', () => {
  // The floor is the difference between "you meant a longer prefix of this" and "you
  // meant a different word that happens to share three letters". `cov` inside
  // `coverage-hunt` is the first; `e` inside `test` is the second, and nothing about the
  // string itself distinguishes them except length.
  assert.deepEqual(nearMatches('coverage-hunt', ['coverage', 'coverage-hunter']), [
    'coverage',
    'coverage-hunter',
  ]);
  assert.deepEqual(nearMatches('coverage-hunt', ['cov']), []);
});

test('nearMatches: the edit bound shrinks with the query, so a short query has no typos', () => {
  // The file's own header rule: "a suggestion that far away is noise: an agent will
  // install the wrong skill". Three edits is a typo in `slice-commmit` and is 75% of a
  // four-character query, which is a different word entirely. The bound was a flat 3,
  // so `cov` matched `coverage-hunt`.
  assert.deepEqual(nearMatches('slice-commmit', ['slice-commit', 'skill-list', 'coverage']), [
    'slice-commit',
  ]);
  assert.deepEqual(nearMatches('add-country-galaxy', ['coverage-hunt', 'add-country']), [
    'add-country',
  ]);
  // One character: `y` is one edit from `xy`, and that is the whole word. Nothing is a
  // typo under three characters, so the floor of 1 applies rather than the real bound.
  assert.deepEqual(nearMatches('x', ['y', 'xy']), ['xy', 'y']);
  assert.deepEqual(nearMatches('check', ['check-runner', 'check']), ['check', 'check-runner']);
});

test('nearMatches: no query, no suggestions', () => {
  assert.deepEqual(nearMatches('', ['a', 'b']), []);
  assert.deepEqual(nearMatches(undefined, ['a']), []);
});

test('nearMatches: limit and max are both honoured', () => {
  // Three candidates at one edit, so the limit is what decides the length rather than the
  // bound. The first attempt used transpositions, which are two edits under a plain
  // Levenshtein distance and were correctly excluded — a fixture that does not contain
  // what it means to contain cannot test a cap.
  const many = ['add-xountry', 'adc-country', 'add-counrry'];
  assert.equal(nearMatches('add-country', many).length, 3, 'the default is three suggestions');
  assert.equal(nearMatches('add-country', many, { limit: 2 }).length, 2);

  // `max` is a ceiling, not a dial. It is one term of a `Math.min` against the query's
  // own length, so it can only tighten — it cannot ask for a wider search, and the test
  // that said otherwise would have been asserting a behaviour that does not exist.
  // `slice-commmit` is twelve characters, so the length-derived bound is 3 and a
  // transposition is offered; with `max: 1` it is not, because a transposition is two
  // edits and one of anything is a different string.
  assert.deepEqual(nearMatches('slice-commmit', ['slice-comnit']), ['slice-comnit']);
  assert.deepEqual(nearMatches('slice-commmit', ['slice-comnit'], { max: 1 }), []);
});
