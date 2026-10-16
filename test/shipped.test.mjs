// Every byte simt-dev ships into another repository, checked against the rule in
// AGENTS.md: it must be readable and actionable by someone who has only the
// receiving repository.
//
// This file exists because that rule was stated and then violated repeatedly. The
// first violations were found by hand, after the text had already reached a repo.
// A rule an agent can read is worth less than a gate it cannot pass, so each
// violation class here is a failing test rather than a paragraph.
//
// The distinction these tests draw is never "does this look like an internal path".
// It is "who owns this path" - see the docs/plans/ case in LEAKS below, which is
// a correct default that a naive grep would flag.

import assert from 'node:assert/strict';
import { cmd } from './fixture.mjs';
import { CLI, PROJECT } from '../src/name.mjs';
import { loadDecisions } from '../src/decisions/index.mjs';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { loadRules, select, LOCAL_PROFILE_DIR } from '../src/projection/project.mjs';
import { desiredRegion, mdcTargets } from '../src/projection/rules.mjs';
import { DECISIONS_DIR, ESTATE_NAME } from '../src/decisions/index.mjs';
import { loadMdcRules, renderMdc, ruleName } from '../src/projection/mdc.mjs';
import { SURFACES, rulePath, surface, undocumentedKeys } from '../src/projection/surfaces.mjs';
import { compose } from '../src/projection/markers.mjs';
import { renderShim } from '../src/hooks/shim.mjs';
import { buildManifest } from '../src/projection/manifest.mjs';
import { PACKAGE_ROOT } from '../src/workspace.mjs';
import { dispatch } from '../src/commands/index.mjs';
import { EXIT } from '../src/output/index.mjs';
import { assertClean } from './leaks.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Runs the real binary in a child process and returns its exit code and output.
// Tests that assert on command output must use this rather than monkey-patching
// process.stdout.write: under `node --test` the runner itself streams event frames
// containing this checkout's own path into stdout, and a patched capture swallows
// them, so the assertion then passes or fails on the checkout's directory name
// instead of on what the command printed (ADR-031). A child process has its own
// stdout, and it is also what a reader actually runs.
// The promisified form, not the native promise: on Node 26 `await execFile(...)`
// resolves with the ChildProcess itself (stdout still a stream), not collected strings.
const execCli = promisify(execFile);

async function runCli(args) {
  const cwd = await mkdtemp(join(tmpdir(), 'simt-cli-'));
  try {
    const { stdout } = await execCli('node', [join(ROOT, 'bin', 'simt-dev.mjs'), ...args], { cwd });
    return { code: 0, stdout };
  } catch (failure) {
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
    };
  }
}

// Every profile in the repo, so adding one cannot opt out of these checks.
// Derived rather than written out: the list this replaced was a hand-maintained
// copy that only failed when an entry was REMOVED — S28 added four profiles and
// renamed one, every new body was unchecked, and the suite stayed green. The leak
// check above reads the same loadRules() this does, so a second copy of the set
// guarded nothing; what is worth asserting is the property the copy was standing
// in for, which is that every applies list names a tag the detector emits.
test('every profile selects on a tag fingerprint() can emit', async () => {
  const rules = await loadRules();
  const profiles = rules.filter((r) => r.id !== null);
  assert.ok(profiles.length >= 8, `expected a non-trivial profile set, got ${profiles.length}`);
  for (const rule of profiles) {
    assert.equal(rule.error, null, `${rule.source}: ${rule.error}`);
    assert.ok(rule.id !== 'core' || rule.applies === 'always', `${rule.source} should apply always`);
  }
  assert.equal(
    rules.filter((r) => r.id === null).length,
    0,
    `a profile with no id is projected but can never be selected: ${rules
      .filter((r) => r.id === null)
      .map((r) => r.source)
      .join(', ')}`,
  );
});

// --- 1. The rule bodies -------------------------------------------------------------

test('no rule body ships text only its author can act on', async () => {
  const rules = await loadRules();
  assert.ok(rules.length >= 8, 'expected the rule set to be non-trivial');
  for (const rule of rules) {
    assertClean(`rules/${rule.file}`, rule.body);
  }
});

// A rule that applies to every stack cannot name one ecosystem's files. `./gradlew`
// is right in jvm-android and wrong in core; "the runner manifest" is right in both.
// Found when simt-app, the first non-npm adopter, received a core rule telling it to
// read package.json — a file it has never had and never will.
// Grouped by ecosystem, because naming several is the rule working and naming one is
// the rule assuming. `core` lists npm, Gradle and Python as examples of "your own
// runner" and that is correct for a repository on any of the three.
const ECOSYSTEMS = [
  { name: 'npm', files: ['package.json', 'npm run'] },
  { name: 'gradle', files: ['gradlew', 'spotless'] },
  { name: 'python', files: ['pyproject.toml', 'uv run', 'requirements.txt', 'pytest', 'ruff'] },
  { name: 'rust', files: ['Cargo.toml', 'cargo'] },
  { name: 'go', files: ['go.mod', 'golangci'] },
  { name: 'bun', files: ['bun.lockb'] },
];

/** Does this `applies` value mean "every repository"? `'always'` and `[]` both do. */
function isStackAgnostic(applies) {
  return applies === 'always' || (Array.isArray(applies) && applies.length === 0);
}

/**
 * The one ecosystem this sentence speaks in, or null.
 *
 * Naming several ecosystems is the rule working — "npm run, uv run -m, ./gradlew" is a
 * list of examples, not a claim about npm. Naming exactly one, alone, is the claim.
 */
function singleEcosystem(sentence) {
  const named = ECOSYSTEMS.filter((e) => e.files.some((f) => sentence.includes(f)));
  return named.length === 1 ? named[0].name : null;
}

/** Bullets and headings are units; hard-wrapped continuation lines are not sentences. */
function sentences(text) {
  return text
    .split(/\n(?=\s*(?:[-*]|#|\d+\.)\s)/)
    .flatMap((block) => block.replace(/\s*\n\s*/g, ' '))
    .flatMap((line) => line.split(/(?<=[.;])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

test('a stack-agnostic rule does not single out one ecosystem as the runner', async () => {
  const rules = await loadRules();
  // Per SENTENCE, not per body. A body that lists npm, Gradle and Python as examples is
  // the rule working, and it masks a neighbouring sentence that asserts package.json is
  // *the* runner manifest — which is how this check passed a mutation restoring the very
  // sentence it was written for.
  //
  // Wrapped lines are joined first. These rules are hard-wrapped at 90 columns, so
  // splitting on newlines cuts a sentence in half and blames whichever half happens to
  // name fewer ecosystems than the whole.
  for (const rule of rules) {
    if (!isStackAgnostic(rule.applies)) continue;
    for (const sentence of sentences(rule.body)) {
      const named = singleEcosystem(sentence);
      assert.ok(
        named === null,
        `rules/${rule.file} applies to every repo, and this sentence speaks only in ${named}'s terms: "${sentence}". Say what the thing is (the runner manifest, the build task) and let the stack profile name the file — or list the runners side by side.`,
      );
    }
  }
});

// The same rule applies to the canonical `.mdc` files, which land in `.cursor/rules/`
// and are read without any of the prose around them. `test-gate` taught "name exact
// commands and test files" using `npm run test:focused`, a filename no Gradle, Python
// or Rust repo has — and it is the rule every other rule about evidence defers to.
test('a stack-agnostic .mdc rule does not single out one ecosystem either', async () => {
  const mdc = await loadMdcRules();
  assert.ok(mdc.length >= 3, 'expected the .mdc rule set to be non-trivial');
  for (const rule of mdc) {
    if (!isStackAgnostic(rule.applies)) continue;
    for (const sentence of sentences(rule.body)) {
      const named = singleEcosystem(sentence);
      assert.ok(
        named === null,
        `rules/mdc/${rule.file} applies to every repo, and this sentence speaks only in ${named}'s terms: "${sentence}". Make the runner a substitution, as intake-questions already does for the plan glob.`,
      );
    }
  }
});

// --- 2. What a rule projects to, for a repo that gets it -----------------------------

test('a rendered projection is clean for every stack that selects it', async () => {
  const rules = await loadRules();
  for (const stack of [['python'], ['gradle', 'kotlin', 'wear-os'], ['cloudflare-workers', 'hono'], ['react', 'firebase'], ['node']]) {
    const { selected } = select(rules, stack);
    assert.ok(selected.length > 0, `no rules selected for ${stack.join(',')}`);
    const body = selected.map((r) => r.body).join('\n\n');
    assertClean(`projection for ${stack.join(',')}`, body);
  }
});

test('a rendered .mdc is clean, with no repo substitutions supplied', async () => {
  for (const rule of await loadMdcRules()) {
    const { body } = renderMdc(rule, {});
    assertClean(`rendered ${rule.id}.mdc`, body);
  }
});

// --- 3. The other artefacts that land in a consumer -----------------------------------

test('the generated-region header names only actions a reader can take', () => {
  const text = compose('Body.', { sha: 'abc1234', sources: ['rules/core.md'] });
  assertClean('generated-region header', text);
  // The command it tells them to run must exist under the shipped name. This line
  // ships into every consumer's AGENTS.md, so it is the one instruction with no
  // second chance: a reader has only this repo to go on. `sync` previews unless
  // told to write (ADR-035), so the bare spelling would tell them to run it and
  // watch nothing happen — an instruction that was correct when written and false
  // the moment the preview became the default.
  assert.match(text, cmd('{cli} sync --yes'), text);
  assert.doesNotMatch(text, cmd('{cli} sync`'), text);
  assert.match(text, /Do not edit/i, text);
});

test('every remedy names a command that does what the remedy claims', async () => {
  // A remedy is read by someone who has no other context, and the whole promise of
  // a remedy is that running it fixes the thing it names. `sync` used to write by
  // default, so a remedy naming the bare command was true; after ADR-035 it is a
  // preview, and every remedy in the tree silently became a no-op instruction. The
  // assertion has to name the flag, or it passes on both sides of that change.
  //
  // `hooks install` is the second writer that used to write by default, and it took
  // a whole commit and a new decision to find (ADR-040). `--yes` means the same
  // thing there for a second reason: it is also the consent to take over routing git
  // already uses, so a remedy that omits it is refused rather than applied.
  const WRITES = new RegExp(`(?:${CLI} sync|${CLI} hooks install)\\b`, 'g');
  const AUTHORISES = /--yes\b|--check\b/;
  const offenders = [];

  for (const file of await collect(join(ROOT, 'src'), ['.mjs'])) {
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    for (const [at, line] of lines.entries()) {
      // Prose about the tool is not an instruction to run it, and `hooks.mjs`'s own
      // header names the command in its usage line. Skipping the comment forms is
      // what keeps this a guard on remedies rather than a guard on the word.
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;

      // The occurrence, not the string containing it. A remedy is usually one clause
      // inside a longer template literal, and matching the literal would report a
      // whole help block as an offender and hide the clause that is actually wrong.
      //
      // The flag is searched for on the rest of the line rather than immediately
      // after the command, because a remedy may put other flags first -
      // `simt-dev hooks install --root R --yes` is the shape `init` prints - and a
      // lookahead would have called that an offender. The search stops at the next
      // `simt-dev` so a correct remedy earlier on a line cannot vouch for a bare
      // one later on it. `[--yes]` in a usage synopsis is the help convention for an
      // optional flag, and matches the same pattern.
      for (const match of line.matchAll(WRITES)) {
        const rest = line.slice(match.index + match[0].length).split('simt-dev')[0];
        if (!AUTHORISES.test(rest)) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${at + 1}: ${match[0]}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `remedies name a writer without the flag it now needs:\n${offenders.join('\n')}`);
});

test('the installed shim tells the reader how to reinstall it', async () => {
  // This file is written into every adopting repository and read by whoever owns
  // it, so it is the one instruction that travels. It names `hooks install` as the
  // way back, and a bare command there is a preview - the reader follows the shim's
  // own instructions, gets no change, and concludes the shim is not reinstallable.
  const shim = renderShim('pre-commit');
  assert.match(shim, cmd('{cli} hooks install --yes'), shim.slice(0, 400));
});

test('the manifest comment describes the manifest', async () => {
  const manifest = buildManifest({ root: '/tmp/some-repo', stack: ['node'], sha: 'abc1234' });
  const text = JSON.stringify(manifest, null, 2);
  assertClean('simt.json (the manifest comment)', text);
  // It must not claim provenance it does not carry. An earlier version said every
  // value cites the ADR that requires it; zero values cited one.
  assert.equal(/\bADR-\d+/.test(text), false, 'the manifest claims ADR provenance it does not carry');
  // The provenance that is real is the recorded SHA.
  assert.match(text, /simtDevSha/, text);
});

// --- 4. Strings the tool prints, which reach a reader in an arbitrary directory -------

test('every command name the tool prints is the name this package ships', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const bin = Object.keys(pkg.bin);
  assert.deepEqual(bin, [CLI], 'the shipped binary name changed; update the guard');

  // The forbidden string here was, until the rename, `simt <verb>` - the command
  // with the hyphen missing. It caught 102 sites at once, all of them remedy text,
  // all of them telling a reader to run something unrunnable. That string is now the
  // CORRECT command, so the check inverts: what does not exist is the project name in
  // command position, `simt-dev <verb>`, which is this tool still telling a reader to
  // run the binary it used to install. Comments are skipped, because several of them
  // name the project while describing it.
  const files = [
    'src/commands/help.mjs', 'src/commands/index.mjs', 'src/commands/sync.mjs',
    'src/commands/init.mjs', 'src/commands/rules.mjs', 'src/commands/skills.mjs',
    'src/commands/skillsinstall.mjs', 'src/commands/hooks.mjs', 'src/commands/upgrade.mjs',
    'src/commands/compare.mjs', 'src/commands/mcp.mjs', 'src/commands/graph.mjs',
    'src/compare/row.mjs', 'src/compare/discover.mjs', 'src/compare/hooksstate.mjs',
    'src/upgrade/plan.mjs', 'src/projection/conflicts.mjs', 'src/projection/manifest.mjs',
    'src/projection/project.mjs', 'src/projection/markers.mjs', 'src/projection/mdc.mjs',
    'src/output/index.mjs', 'src/hooks/shim.mjs', 'src/hooks/gates.mjs',
    'src/hooks/dispatcher.mjs', 'src/mcp/tools.mjs', 'src/mcp/server.mjs',
    'src/decisions/index.mjs', 'src/resolve/source.mjs',
  ];
  for (const file of files) {
    const text = await readFile(join(ROOT, file), 'utf8');
    const code = text.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    const m = new RegExp(`\\b${PROJECT} (?:init|sync|check|rules|skills|hooks|compare|doctor|upgrade|mcp|graph)\\b`).exec(code);
    assert.equal(m, null, `${file} tells the reader to run "${m?.[0]}", and the binary is ${CLI}.`);
  }
});

test('no remedy or pointer names a path that resolves only inside simt-dev', async () => {
  // Scans user-facing *output*, not comments. A comment may and should cite the
  // file a decision lives in - that is how the next maintainer finds it. A remedy
  // may not, because the reader is standing in a different directory.
  const files = [
    'src/commands/help.mjs', 'src/commands/index.mjs', 'src/commands/rules.mjs',
    'src/commands/compare.mjs', 'src/commands/hooks.mjs', 'src/commands/upgrade.mjs',
    'src/commands/skills.mjs', 'src/commands/skillsinstall.mjs', 'src/commands/init.mjs',
    'src/commands/sync.mjs', 'src/commands/agenthook.mjs',
    'src/compare/row.mjs', 'src/compare/discover.mjs', 'src/upgrade/plan.mjs',
    'src/projection/conflicts.mjs', 'src/projection/manifest.mjs', 'src/projection/project.mjs',
    'src/output/index.mjs',
    'src/hooks/gates.mjs', 'src/hooks/shim.mjs', 'src/mcp/tools.mjs',
    'src/agenthooks/render.mjs',
  ];
  // Strip comments so the check is about what a reader sees.
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\*).*$/gm, '');
  for (const file of files) {
    const text = stripComments(await readFile(join(ROOT, file), 'utf8'));
    for (const path of ['docs/decisions/', 'docs/plans/', 'rules/stacks/', 'rules/mdc/', 'rules/']) {
      assert.ok(!text.includes(path), `${file} prints "${path}", which resolves only inside simt-dev`);
    }
  }
});

const HARNESS_OR_LANGUAGE = [
  { re: /AskQuestion/, what: "Cursor's question tool" },
  { re: /AskUserQuestion/, what: "Claude Code's question tool" },
  { re: /`any`/, what: 'a TypeScript escape' },
  { re: /floating promises/, what: 'TypeScript async vocabulary' },
  { re: /console\.\*/, what: 'a JavaScript debug call' },
];

test('core and process rules do not name one language or one harness', async () => {
  const files = [
    'rules/core.md',
    ...(await readdir(join(ROOT, 'rules', 'mdc'))).filter((n) => n.endsWith('.mdc')).map((n) => `rules/mdc/${n}`),
  ];
  for (const file of files) {
    const raw = await readFile(join(ROOT, file), 'utf8');
    const body = raw.replace(/^---\n[\s\S]*?\n---\n*/, '').replace(/\{\{[a-zA-Z0-9_-]+\}\}/g, '');
    for (const { re, what } of HARNESS_OR_LANGUAGE) {
      assert.equal(re.exec(body), null, `${file} names ${what} outside a substitution`);
    }
  }
});

test('a Kotlin repo rendered for Claude Code names neither a TypeScript escape nor a Cursor tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-s45-'));
  await mkdir(join(root, 'src/main/kotlin'), { recursive: true });
  await writeFile(join(root, 'simt-dev.json'), JSON.stringify({ surfaces: ['claude'] }));
  await writeFile(join(root, 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
  await writeFile(join(root, 'src/main/kotlin/Api.kt'), 'class Api\n');
  const desired = await desiredRegion(root, {});
  assert.ok(desired.profiles.includes('jvm'), desired.profiles.join(','));
  assert.equal(desired.profiles.includes('typescript'), false);
  assert.doesNotMatch(desired.body, /`any`/);
  assert.doesNotMatch(desired.body, /(?<![A-Za-z])AskQuestion/);
  const { targets } = await mdcTargets(root, desired.meta.sha, desired.manifest, {});
  const intake = targets.find((t) => t.file.endsWith('intake-questions.md'));
  assert.ok(intake, targets.map((t) => t.file).join(','));
  assert.match(intake.body, /AskUserQuestion/);
  assert.doesNotMatch(intake.body, /(?<![A-Za-z])AskQuestion/);
  assert.match(intake.body, /offering choices with the recommended one first|AskUserQuestion/);
});

test('a question tool is named only when every selected surface agrees', async () => {
  async function intake(surfaces) {
    const root = await mkdtemp(join(tmpdir(), 'simt-ask-'));
    await writeFile(join(root, 'simt-dev.json'), JSON.stringify({ surfaces }));
    const desired = await desiredRegion(root, {});
    const { targets } = await mdcTargets(root, desired.meta.sha, desired.manifest, {});
    const file = targets.find((t) => t.file.includes('intake-questions'));
    const folded = desired.folded.includes('intake-questions') ? desired.body : '';
    return `${file?.body ?? ''}\n${folded}`;
  }
  const cursor = await intake(['cursor']);
  assert.match(cursor, /(?<![A-Za-z])AskQuestion/);
  const both = await intake(['cursor', 'claude']);
  assert.doesNotMatch(both, /(?<![A-Za-z])AskQuestion/);
  assert.doesNotMatch(both, /AskUserQuestion/);
  assert.match(both, /Ask the user, offering choices with the recommended one first/);
});

test('core does not claim every rule cites a decision', async () => {
  const text = await readFile(join(ROOT, 'rules/core.md'), 'utf8');
  assert.doesNotMatch(text, /Every rule below carries the number/);
});

test('rules why does not name an estate repository', async () => {
  const { code, stdout } = await runCli(['rules', 'why', 'ADR-001']);
  assert.equal(code, EXIT.OK, stdout);
  assert.equal(ESTATE_NAME.exec(stdout), null, `rules why names an estate repository:\n${stdout}`);
  assert.match(stdout, /push only on explicit user approval/);
});

test('every repository the skill registry names is denied by the leak guard', async () => {
  const graph = JSON.parse(await readFile(join(ROOT, 'graph/skills.graph.json'), 'utf8'));
  const repos = new Set(
    (graph.skills ?? []).flatMap((skill) => (skill.sources ?? []).map((source) => source.repo)),
  );
  assert.ok(repos.size > 0, 'the registry named no repositories to derive the guard from');
  for (const repo of repos) {
    assert.match(repo, new RegExp(ESTATE_NAME.source), `${repo} is in the registry and would pass the leak guard`);
  }
  // Not in the registry today. A prefix match is what keeps the next simt-* name from
  // needing a hand edit; this is the name the old alternation missed.
  assert.match('simt-api', new RegExp(ESTATE_NAME.source));
  assert.doesNotMatch('simt-dev', new RegExp(ESTATE_NAME.source));
});

test('help does not describe the tool as belonging to one estate', async () => {
  const { code, stdout } = await runCli(['help']);
  assert.equal(code, EXIT.OK, stdout);
  assert.ok(stdout.length > 200, 'help produced nothing to check');
  assertClean('simt-dev help', stdout);
  // It previously said "for the SIMT ecosystem", which is the same assumption as a
  // repository name in a projected rule, one level up.
  assert.ok(!/\bSIMT\b/.test(stdout), 'help claims the tool belongs to one estate');
});

// --- 5. The failure mode that started all of this ------------------------------------

test('the check is not vacuous: a known leak is actually caught', async () => {
  // A guard that cannot fail is decoration. Assert the detector works by feeding it
  // each class of violation it exists to catch.
  for (const sample of [
    'Edit the source in simt-dev and run: simt sync.',
    'Settled by an ADR in `docs/decisions/`.',
    'Stack bodies live in `rules/stacks/`.',
    'Unlike simt-app, do this.',
    'Unlike simt-api, do this.',
    'This file is projected into each repo.',
    'Only what is true in all 16 repos.',
  ]) {
    let threw = false;
    try {
      assertClean('sample', sample);
    } catch {
      threw = true;
    }
    assert.ok(threw, `the guard failed to catch: ${JSON.stringify(sample)}`);
  }
});

// --- 8. Every surface a rule is written to --------------------------------------------
//
// A rule is no longer written to one place. It is written to up to four, each read by a
// different editor, and the cost of getting that wrong is asymmetric: a key an editor
// ignores is invisible, and a value it does not recognise can make it discard the rule
// with no error at all (Antigravity documents exactly that for `.agents/rules/*.md`).
// So the frontmatter is checked against what each vendor's own document says.

test('every frontmatter key a surface emits is one its vendor documents', () => {
  assert.deepEqual(undocumentedKeys(), []);
});

test('no surface emits a rule file without a path or a documented way to load it', () => {
  for (const s of SURFACES) {
    assert.ok(s.label && s.readers.length > 0, `${s.id} does not name who reads it`);
    assert.ok(
      typeof s.verified === 'string' && s.verified.length > 0,
      `${s.id} does not name the document it was verified against`,
    );
    if (s.rule === null) {
      assert.equal(s.ruleFrontmatter, undefined, `${s.id} has no rule files but declares frontmatter`);
      continue;
    }
    assert.equal(typeof s.ruleFrontmatter, 'function', `${s.id} writes rule files but no frontmatter`);
    // A path template must be a relative repo path. An absolute one is a path that
    // resolves only inside this repository - the LEAKS class, in a filename.
    assert.doesNotMatch(
      s.rule,
      /^\//,
      `${s.id} writes rule files to an absolute path: ${s.rule}`,
    );
    assert.equal(
      s.rule.includes('{name}'),
      true,
      `${s.id} has no per-rule file name, so two rules would collide: ${s.rule}`,
    );
  }
});

test('a rule rendered for every surface is clean on every surface', async () => {
  for (const rule of await loadMdcRules()) {
    const { body } = renderMdc(rule, {});
    const name = ruleName(rule);
    let written = 0;
    for (const s of SURFACES) {
      if (s.rule === null) continue;
      const rel = rulePath(s.id, name);
      assert.ok(rel, `${s.id} has no path for rule ${rule.id}`);
      assertClean(`${rel} (frontmatter)`, s.ruleFrontmatter(rule).join('\n'));
      assertClean(`${rel} (body)`, body);
      // The same body everywhere: a surface must not get a shorter or paraphrased copy,
      // or the four files are four rules again and only one of them is auditable.
      assert.ok(body.length > 0, `${rel} would be an empty rule`);
      written += 1;
    }
    assert.ok(written >= 4, `rule ${rule.id} reaches ${written} surfaces, expected at least 4`);
  }
});

test('the surface gate is not vacuous: an invented key and an invented path both fail', () => {
  const invented = [
    {
      ...surface('antigravity'),
      ruleFrontmatter: (r) => ['trigger: always_on', `priority: ${r.id}`],
    },
  ];
  const keys = undocumentedKeys(invented);
  assert.equal(keys.length, 1, 'an undocumented frontmatter key was not reported');
  assert.match(keys[0], /antigravity emits frontmatter key "priority"/);

  const badPath = [{ ...surface('cursor'), rule: 'rules/{name}.mdc' }];
  for (const s of badPath) {
    assert.doesNotMatch(s.rule, /^\//);
  }
  assert.ok(surface('cursor').rule.includes('{name}'), 'the {name} placeholder is load-bearing');
});

// --- 9. The decision records ---------------------------------------------------------
//
// ADR records were written for this organisation and ship in the package. They were
// exempt from every check here because nothing delivered them to a reader - until a
// rule's inline `(ADR-NNN)` citation made `simt-dev rules why` reachable, and that
// command was printing a title and a status and nothing else. The citation was
// decoration; it is now a working reference, and the records it opens are subject to
// the same rule as everything else the tool says.

test('no shipped decision record names a command this package does not install', async () => {
  // Found by reading a `rules why` answer: ADR-005 told the reader to run `simt check`,
  // which is not a command. Twenty-one occurrences across eight records, all invisible
  // to a check that only looked at rule bodies.
  //
  // This guard has now been wrong twice, both times for the same reason: it asserted a
  // SPELLING while the rule it protects is about runnable commands. It first forbade
  // `simt check`, which stopped being a defect the day the command was renamed to `simt`.
  // Then it forbade `simt-dev check` in the file, which was right about the spelling and
  // wrong about the surface — fifty records quote the command their own output ran when
  // the binary was `simt-dev`, and a record is never edited in place, so the quotation
  // stays in the file as evidence of what happened.
  //
  // So this checks what is PRINTED, not what is stored. `loadDecisions` converts the old
  // command on the way out, and the question worth asking is whether the conversion
  // reached every field a reader actually sees.
  const { decisions } = await loadDecisions();

  for (const d of decisions) {
    for (const field of [d.status, ...d.summary.ruled, ...d.summary.rejected]) {
      const m = /\bsimt-dev (?:sync|check|init|doctor|skills|rules|hooks|compare|upgrade|mcp|graph)\b/.exec(field);
      assert.equal(m, null, `${d.id} prints "${m?.[0]}", and the command is ${CLI}`);
    }
  }
  // Not vacuous. The pattern above does fire on the raw stored text, so the check is
  // asserting that the conversion happens rather than that the field is empty.
  const raw = await readFile(join(DECISIONS_DIR, 'ADR-036-a-writer-that-writes-says-so-and-the-instructions-naming-it-move-with-it.md'), 'utf8');
  assert.match(raw, /\bsimt-dev sync\b/, 'the stored text no longer quotes the command it quoted, so the redaction cannot be what is failing here');
});

test('the shipped command is the spelling the records are allowed to use', async () => {
  // The other direction: the conversion must actually run. A guard that only knows how to
  // reject is a guard that can be satisfied by deleting its subject.
  const { decisions } = await loadDecisions();
  assert.ok(decisions.length > 40, 'the decision index is empty, so nothing above proved anything');
  const printed = decisions.flatMap((d) => [d.status, ...d.summary.ruled, ...d.summary.rejected]).join('\n');
  assert.match(printed, new RegExp(`\\b${CLI} (?:sync|check|init|hooks)\\b`), 'no record prints the command this package installs, so the redaction cannot be doing anything');
});


test('every decision record yields a ruling, so a citation can never dead-end', async () => {
  // The whole value of a citation is that following it answers something. A record
  // whose ruling cannot be extracted prints a title and a status, which answers only
  // the smaller half of the question.
  const { loadDecisions } = await import('../src/decisions/index.mjs');
  const { ok, decisions, errors } = await loadDecisions();
  assert.equal(ok, true, errors.join('; '));
  assert.ok(decisions.length >= 10);
  for (const d of decisions) {
    assert.ok(d.summary.ruled.length > 0, `${d.id} has no extractable ruling`);
    for (const line of d.summary.ruled) {
      // A lead-in ending in a colon has no predicate. It was what ADR-005's summary
      // opened with: "Two tiers, both advisory in wording but checkable in `simt check`:"
      // followed by nothing.
      assert.ok(!line.endsWith(':'), `${d.id} ruling ends in a colon with nothing after it`);
      assert.ok(line.length > 40, `${d.id} ruling is too short to be an answer: ${JSON.stringify(line)}`);
    }
  }
});

test('a superseded record answers with what replaced it, not with the reversal', async () => {
  // ADR-011 ruled that Windows is supported; ADR-012 reversed it the same day.
  // Printing the old ruling under a SUPERSEDED banner is a reversed instruction with
  // a warning attached.
  const { loadDecisions } = await import('../src/decisions/index.mjs');
  const { decisions } = await loadDecisions();
  const superseded = decisions.filter((d) => d.supersededBy);
  assert.ok(superseded.length > 0, 'no superseded record to check; the estate has one');
  for (const d of superseded) {
    const replacement = decisions.find((x) => x.id === d.supersededBy);
    assert.ok(replacement, `${d.id} names a replacement that does not exist`);
    assert.ok(replacement.summary.ruled.length > 0, `${replacement.id} has no extractable ruling`);
  }
});

test('a decision record names the repositories it was written about, so the reader knows what to discount', async () => {
  // The records are evidence: they say which repositories used to hold which rule, and
  // that is why they are worth keeping. Stripping it would make a record claim to be
  // about a rule nobody ever held. Reporting it is the honest middle - the reader
  // learns which parts are not about them, without the prose being mangled.
  const { loadDecisions } = await import('../src/decisions/index.mjs');
  const { decisions } = await loadDecisions();
  const withEstate = decisions.filter((d) => d.summary.writtenAgainst.length > 0);
  assert.ok(withEstate.length > 0, 'no record names the estate it was written about');
  for (const d of withEstate) {
    assert.ok(Array.isArray(d.summary.writtenAgainst));
    assert.deepEqual([...d.summary.writtenAgainst].sort(), d.summary.writtenAgainst);
  }
});

// --- 10. Who owns a key ---------------------------------------------------------------
//
// A canonical rule file holds two vocabularies in one frontmatter block: this tool's
// own instructions, and the keys an editor reads before any rule text. They looked
// alike — `alwaysApply: true` sat four lines from `applies: always`, both of them
// about always — so the file could not say which reader owned which. ADR-022 gives
// every key this tool reads a `simt-` prefix. The cost of the prefix is that a file
// which forgets it now selects nothing, silently, which is the defect ADR-016 found
// once already; these tests are what make that loud.

/** Keys a reader owns, per file kind, with the surface row that documents each one. */
const READER_KEYS = {
  '.mdc': new Set(['description', 'alwaysApply']),
  '.md': new Set(),
};

function frontmatterKeys(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((line) => /^([a-zA-Z][a-zA-Z0-9_-]*):/.exec(line.trim()))
    .filter(Boolean)
    .map((kv) => kv[1])
    .filter((k) => !['key', 'default', 'describe'].includes(k));
}

test('every key a shipped rule declares is prefixed, or is a key its reader owns', async () => {
  const files = [
    ...(await readdir(join(ROOT, 'rules'))).filter((n) => n.endsWith('.md')).map((n) => `rules/${n}`),
    ...(await readdir(join(ROOT, 'rules', 'stacks'))).filter((n) => n.endsWith('.md')).map((n) => `rules/stacks/${n}`),
    ...(await readdir(join(ROOT, 'rules', 'mdc'))).filter((n) => n.endsWith('.mdc')).map((n) => `rules/mdc/${n}`),
  ];
  assert.ok(files.length >= 10, `expected the shipped rule set, found ${files.length} files`);

  for (const rel of files) {
    const ext = rel.endsWith('.mdc') ? '.mdc' : '.md';
    const keys = frontmatterKeys(await readFile(join(ROOT, rel), 'utf8'));
    assert.ok(keys.length > 0, `${rel} has no frontmatter to check`);
    for (const key of keys) {
      assert.ok(
        key.startsWith('simt-') || READER_KEYS[ext].has(key),
        `${rel} declares "${key}", which is neither this tool's own (simt-*) nor a key ${ext === '.mdc' ? 'Cursor' : 'a reader'} reads`,
      );
    }
  }
});

test('no shipped rule carries a bare key, and the loader says which spelling to use', async () => {
  // Not vacuous: this is the file as it was written before ADR-022, and the message is
  // the whole point - a reader who typed the old spelling must be told the new one
  // rather than left to guess.
  const old = '---\nid: x\ntarget: .cursor/rules/x.mdc\napplies: always\n---\n\n# X\n\nBody.\n';
  const parsed = frontmatterKeys(old);
  assert.deepEqual(parsed, ['id', 'target', 'applies']);
  for (const key of parsed) {
    assert.equal(key.startsWith('simt-'), false, `${key} would have passed the guard`);
  }

  const { loadMdcRules } = await import('../src/projection/mdc.mjs');
  const rules = await loadMdcRules();
  for (const rule of rules) {
    assert.equal(rule.error, null, `rules/mdc/${rule.file}: ${rule.error}`);
  }
});

test('a bare key in a rule file is reported with the prefixed spelling, not ignored', async () => {
  // Not a hypothetical. ADR-016 records a rule that shipped, was tested for its presence
  // on disk, and reached no repository, because its selection key was missing. A repo's
  // own profile is written by hand and can carry the old spelling, so the loader has to
  // name the new one rather than treat the key as absent.
  const root = await mkdtemp(join(tmpdir(), 'simt-prefix-'));
  await mkdir(join(root, LOCAL_PROFILE_DIR), { recursive: true });
  for (const [name, fm] of [
    ['applies.md', 'simt-id: a\napplies: [node]\n'],
    ['fallback.md', 'simt-id: b\nsimt-applies: [node]\nfallback: true\n'],
    ['invented.md', 'simt-id: c\nsimt-applies: [node]\ninvented: yes\n'],
    // A bare `priority` is no longer an invented key: it is this tool's own, one
    // `simt-` away (R07's classes), and a loader that called it unrecognised would send
    // a reader looking for a third spelling that does not exist.
    ['priority.md', 'simt-id: d\nsimt-applies: [node]\npriority: hard\n'],
  ]) {
    await writeFile(join(root, LOCAL_PROFILE_DIR, name), `---\n${fm}---\n\nBody.\n`);
  }

  const local = (await loadRules(root)).filter((r) => r.origin === 'local');
  const byFile = new Map(local.map((r) => [r.file, r.error]));
  assert.match(byFile.get('applies.md'), /"applies".*spelled "simt-applies"/);
  // The camelCase spelling is the branch worth asserting: `fallback` is one keystroke
  // from `simt-fallback` and nothing else tells the reader which half is missing.
  assert.match(byFile.get('fallback.md'), /"fallback".*spelled "simt-fallback"/);
  assert.match(byFile.get('invented.md'), /unrecognised frontmatter key "invented"/);
  assert.match(byFile.get('priority.md'), /"priority".*spelled "simt-priority"/);
});

async function adrFiles() {
  return (await readdir(DECISIONS_DIR)).filter((n) => /^ADR-\d{3}-.*\.md$/.test(n)).sort();
}

/** Every file under `dir` with the given extension, sorted, so a failure names a path. */
/**
 * Every file under a published root.
 *
 * `.md` and text only, at first — which was right for `docs/decisions` and `rules` and
 * was never re-examined when `graph` was added to the published set. The registry at
 * `graph/skills.graph.json` is JSON, so it was published and invisible to the guard
 * above: 51 strings naming eight private repositories, five of them the `.repo`
 * property `src/resolve/source.mjs:40` joins to find a skill body. A guard that cannot
 * see the leak is worse than no guard, because it answers the question the reader
 * asked rather than the one they meant.
 *
 * Text, not binary: the guard is a pattern over source. A `.png` carrying bytes that
 * happen to spell a repository name is not this tool doing it, and reading one as
 * text would fail on encoding rather than on a leak.
 */
async function collect(dir, exts = TEXT_EXTENSIONS) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full, exts)));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out.sort();
}

// The estate's private repository names, read from the published package's own metadata
// rather than from a list written here. A guard whose list is maintained by hand is a
// list that stops covering the estate the day a repository is added, which is the same
// defect ADR-042 records for a declared value nobody executes.
// The estate's private repository names, as a *shape* and never as a list.
//
// This tool does not know which repositories use it, and it must not. `ESTATE_NAME`'s
// own comment records that decision and the reason for it: enumerating the names put the
// whole portfolio into every adopting repository. A list written here is the same defect
// in a file that merely happens not to be published today, and becomes published the day
// somebody adds `test/` to `files`.
//
// So the rule is this tool's own name followed by a suffix — generic over every repository
// sharing the prefix, naming none of them. The suffix `id`, `title` and the rest are the
// tool's *own* vocabulary (ADR-022), read from the modules that own it rather than copied
// here, because a second copy of a set is a copy that drifts and then forgives.
//
// The `repo-NN` labels the records carry are a shape — two digits, not a name — and do
// not match this pattern at all: they are the replacement the sweep made, not a second leak.
//
// The honest limit, which this does not fix: a repository whose name does not begin with
// this tool's name is not detectable by any rule that does not enumerate it. The sweep
// found those by hand and they remain a review rule. A tool that could catch them
// mechanically would have to be told them, and being told them is the leak.
const TOOL_OWN_WORDS = new Set([
  ...(await import('../src/projection/mdc.mjs')).KNOWN_KEYS,
  ...(await import('../src/projection/rules.mjs')).PROFILE_KEYS,
  // The rest of the names this tool owns, which are not frontmatter. The inferability
  // marker is one of them: it is a name a rule author types, not a repository that
  // happens to share the prefix, and the allowlist is where this file already says which
  // of the prefixed names are the tool's own (ADR-078).
  (await import('../src/kernel/inferability.mjs')).INFERABLE_MARKER,
  'simt-dev',
  'simt-dev-check',
  'simt-hooks',
]);

/**
 * Records that argue *about* the prefix and therefore have to spell it.
 *
 * Each entry is a file and a reason, never a repository. That is the difference from a
 * list of names and it is the whole point: an exemption says "this document discusses the
 * namespace", which is a fact about this tool and carries nothing about whoever uses it.
 * The rule below catches every repository sharing the prefix, which is the leak; these
 * two files are where the prefix itself is the subject, and a generic pattern cannot tell
 * a hypothetical key in an argument from a repository name — `simt-gates` and `simt-api`
 * are the same shape.
 *
 * A stale exemption fails: every entry must still be tripping the rule, so one that stops
 * being needed is removed rather than kept as a precedent.
 */
const PREFIX_ARGUING_RECORDS = {
  'ADR-022-a-key-simt-dev-reads-is-prefixed.md': 'is the record arguing for the prefix, using hypothetical keys as examples',
  'ADR-026-a-config-without-a-region-is-a-file-the-repo-owns.md': 'names one prefixed key to record Dependabot rejecting it',
};

/** `simt-<word>` that is not one of this tool's own names, per line, or null. */
function estateNameIn(line) {
  for (const m of line.matchAll(/\bsimt-(?!dev\b)([\w-]+)\b/g)) {
    if (!TOOL_OWN_WORDS.has(m[0])) return m[0];
  }
  return null;
}

/**
 * Every estate name in a published file, or null.
 *
 * @param {string} label path relative to the package root, which is also the exemption key
 * @param {string} text
 * @returns {string[]}
 */
function estateNamesInFile(label, text) {
  const basename = label.split('/').pop();
  if (label.startsWith('docs/decisions/') && PREFIX_ARGUING_RECORDS[basename]) return [];
  return text
    .split('\n')
    .flatMap((line, i) => (estateNameIn(line) ? [`${label}:${i + 1}  ${JSON.stringify(estateNameIn(line))}`] : []));
}

const SHIPPED_ROOTS = ['bin', 'src', 'rules', 'docs/decisions'];
const SHIPPED_FILES = ['CHANGELOG.md', 'README.md', 'LICENSE', 'package.json'];

/**
 * Extensions a pattern over source can run against. Deliberately not everything: a
 * binary that happens to contain the bytes is not this tool naming anything, and
 * reading it as text fails on encoding instead of on a leak.
 */
const TEXT_EXTENSIONS = ['.md', '.mjs', '.json', '.yml', '.yaml', '.toml', '.sh'];

test('nothing this package publishes names a repository from this estate', async () => {
  // These records ship. `pyproject.toml` force-includes `docs/decisions` into the wheel
  // and the sdist, and `package.json`'s `files` list carries the same directory into the
  // npm tarball, so a name written into an ADR is published to three registries. The
  // sweep that pseudonymised them had to touch 28 records because nothing stopped the
  // next one.
  //
  // `redactEstate` is not this guard, and the sweep's own commit says so: it redacts on
  // the way *out*, at print time, and the bytes on disk are what get published. A reader
  // installing the wheel and grepping it finds every name written here.
  const offenders = [];


  for (const root of SHIPPED_ROOTS) {
    // The whole published root, not only its Markdown. See `TEXT_EXTENSIONS`: the
    // registry at graph/skills.graph.json is JSON, and the version of this guard that
    // read `.md` only published it to npm with 51 strings naming private repositories.
    for (const file of await collect(join(ROOT, root))) {
      const label = file.replace(`${ROOT}/`, '');
      offenders.push(...estateNamesInFile(label, await readFile(file, 'utf8')));
    }
  }
  for (const file of SHIPPED_FILES) {
    offenders.push(...estateNamesInFile(file, await readFile(join(ROOT, file), 'utf8')));
  }

  assert.deepEqual(
    offenders,
    [],
    `these published files name a private repository. Name it by what it IS - "a Gradle\n` +
      `module with no wrapper", "a repository with no package.json" - or use the stable\n` +
      `repo-NN label, and put the real name in the commit message where nothing ships it:\n` +
      `${offenders.join('\n')}`,
  );
});


test('the guard above covers what is actually published', async () => {
  // A guard scoped to a hand-written list checks that list. This one is scoped to the
  // published set, so it has to be *equal* to that set in both directions or it is
  // theatre: adding a directory to `files` without adding it here would leave it
  // unguarded, and no failure would name the omission.
  //
  // Both directions matter and they fail differently. Guarding something unpublished is
  // a test that can never fail; publishing something unguarded is the leak this exists to
  // prevent. The first is caught here too, because a guard nobody can fail is one
  // somebody eventually deletes.
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const guarded = new Set([...SHIPPED_ROOTS, ...SHIPPED_FILES]);
  const shipped = new Set([...pkg.files, ...SHIPPED_FILES]);

  for (const entry of shipped) {
    assert.ok(guarded.has(entry), `${entry} is published by npm and is not guarded. Add it to SHIPPED_ROOTS or SHIPPED_FILES.`);
  }
  for (const entry of guarded) {
    assert.ok(shipped.has(entry), `${entry} is guarded but is not published by npm, so the guard can never fail on it.`);
  }

  // And the wheel, which is the channel that carries the records.
  const pyproject = await readFile(join(ROOT, 'pyproject.toml'), 'utf8');
  assert.match(pyproject, /"docs\/decisions" = "simt_dev\/vendored\/docs\/decisions"/, 'the wheel no longer ships docs/decisions');
});


test('every exemption from the estate-name rule is still needed, and says why', async () => {
  // An exemption list is where a guard starts rotting: the file gets rewritten, the
  // offending line goes away, and the entry survives to cover the next thing written in
  // it. So each entry is checked twice — that it still trips the rule without the
  // exemption, and that it carries a reason. A reason is the difference between this and
  // a silent hole, and it is checked as a non-empty string rather than trusted.
  for (const [file, reason] of Object.entries(PREFIX_ARGUING_RECORDS)) {
    assert.ok(typeof reason === 'string' && reason.length > 20, `${file} is exempt with no stated reason`);

    const label = `docs/decisions/${file}`;
    const text = await readFile(join(ROOT, label), 'utf8');
    const hits = estateNamesInFile(label, text);
    assert.deepEqual(hits, [], `${file} is exempt but the exemption no longer matches its path`);

    // With the exemption removed, the file must actually trip the rule — otherwise the
    // exemption is covering nothing and should be deleted.
    const real = estateNamesInFile('somewhere/else/file.md', text);
    assert.ok(real.length > 0, `${file} no longer contains a prefixed name, so its exemption is stale`);
  }

  // And every exempt file must still exist, so a rename does not leave an entry pointing
  // at nothing that looks like it is working.
  const present = new Set(await adrFiles());
  for (const file of Object.keys(PREFIX_ARGUING_RECORDS)) {
    assert.ok(present.has(file), `${file} is exempt but no longer exists`);
  }
});
