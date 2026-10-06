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
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readdir } from 'node:fs/promises';
import { loadRules, select } from '../src/projection/project.mjs';
import { DECISIONS_DIR } from '../src/decisions/index.mjs';
import { loadMdcRules, renderMdc } from '../src/projection/mdc.mjs';
import { compose } from '../src/projection/markers.mjs';
import { buildManifest } from '../src/projection/manifest.mjs';
import { PACKAGE_ROOT } from '../src/workspace.mjs';
import { dispatch } from '../src/commands/index.mjs';
import { EXIT } from '../src/output/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Paths and phrases that only mean something inside simt-dev's own tree.
 *
 * `docs/plans/` is deliberately absent. It appears in intake-questions as a
 * substitution DEFAULT: "your plans live here, relative to you". A repo reading
 * it resolves it against itself, which is correct. The defect class is a path
 * that resolves against *this* repository, not a path that resembles one.
 */
const LEAKS = [
  { re: /docs\/decisions\//, what: 'a decision-record path' },
  { re: /rules\/stacks\//, what: 'this repository\'s rule layout' },
  { re: /rules\/core\.md/, what: 'this repository\'s rule layout' },
  { re: /rules\/mdc\//, what: 'this repository\'s rule layout' },
  { re: /\bsimt-(app|space|goto|social|blog|landing|garmin|jobs|media|wearable)\b/, what: 'a repository from this estate' },
  { re: /\b(bunnyland|wakt-app|app-ui)\b/, what: 'a repository from this estate' },
  { re: /\bthe estate\b|\ball 16 repos\b|\bthis audit\b/i, what: 'an investigation artefact' },
];

/** Text addressed to whoever maintains the rules, projected into a repo nobody maintains. */
const AUTHOR_ADDRESSED = [
  { re: /edit the source/i, what: 'an instruction to edit upstream source' },
  { re: /edits here are overwritten/i, what: 'an instruction to edit upstream source' },
  { re: /this file is projected/i, what: 'narration about the projection itself' },
];

// Every profile in the repo, so adding one cannot opt out of these checks.
const PROFILES = ['node', 'python', 'jvm-android', 'connectiq', 'cloudflare-workers', 'react-web', 'container'];

/**
 * Provenance lines the tool writes about itself.
 *
 * `<!-- simt-dev:sources=rules/core.md -->` is namespaced under `simt-dev:`, is an
 * HTML comment an agent never reads, and is the one thing that tells a maintainer
 * which files produced a region. It is tool metadata, not prose addressed to the
 * reader - so it is exempt from the path check and nothing else.
 */
const NAMESPACED_PROVENANCE = /^\s*<!--\s*simt-dev:[^>]*-->\s*$/gm;

function assertClean(where, text) {
  // Author-addressed text is checked everywhere, including comments: the old header
  // said "edit the source in simt-dev" from inside a comment, and that was a real
  // leak to a real reader.
  for (const { re, what } of AUTHOR_ADDRESSED) {
    const m = re.exec(text);
    assert.equal(m, null, `${where} ships ${what}: ${JSON.stringify(m?.[0])}\n\n${text}`);
  }
  const prose = text.replace(NAMESPACED_PROVENANCE, '');
  for (const { re, what } of LEAKS) {
    const m = re.exec(prose);
    assert.equal(m, null, `${where} ships ${what}: ${JSON.stringify(m?.[0])}\n\n${text}`);
  }
}

// --- 1. The rule bodies -------------------------------------------------------------

test('no rule body ships text only its author can act on', async () => {
  const rules = await loadRules();
  assert.ok(rules.length >= 8, 'expected the rule set to be non-trivial');
  for (const rule of rules) {
    assertClean(`rules/${rule.file}`, rule.body);
  }
});

test('every profile is covered by the leak check', async () => {
  const rules = await loadRules();
  const ids = rules.map((r) => r.id);
  for (const profile of PROFILES) {
    assert.ok(ids.includes(profile), `no rule with id "${profile}" exists, so it is unchecked. Found: ${ids.join(', ')}`);
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
  // The command it tells them to run must exist under the shipped name.
  assert.match(text, /simt-dev sync/, text);
  assert.match(text, /Do not edit/i, text);
});

test('the manifest comment describes the manifest', async () => {
  const manifest = buildManifest({ root: '/tmp/some-repo', stack: ['node'], sha: 'abc1234' });
  const text = JSON.stringify(manifest, null, 2);
  assertClean('simt-dev.json', text);
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
  assert.deepEqual(bin, ['simt-dev'], 'the shipped binary name changed; update the guard');

  // Any bare `simt <subcommand>` in user-facing source is a command that does not
  // exist. This caught 102 sites at once, all of them remedy text, all of them
  // telling a reader to run something unrunnable.
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
    const m = /\bsimt (?:init|sync|check|rules|skills|hooks|compare|doctor|upgrade|mcp|graph)\b/.exec(text);
    assert.equal(m, null, `${file} tells the reader to run "${m?.[0]}", which is not a command. The binary is "simt-dev".`);
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
    'src/compare/row.mjs', 'src/compare/discover.mjs', 'src/upgrade/plan.mjs',
    'src/projection/conflicts.mjs', 'src/projection/manifest.mjs', 'src/output/index.mjs',
    'src/hooks/gates.mjs', 'src/hooks/shim.mjs', 'src/mcp/tools.mjs',
  ];
  // Strip comments so the check is about what a reader sees.
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\*).*$/gm, '');
  for (const file of files) {
    const text = stripComments(await readFile(join(ROOT, file), 'utf8'));
    for (const path of ['docs/decisions/', 'docs/plans/', 'rules/stacks/']) {
      assert.ok(!text.includes(path), `${file} prints "${path}", which resolves only inside simt-dev`);
    }
  }
});

test('help does not describe the tool as belonging to one estate', async () => {
  // `help` writes through emit() and returns an exit code, so the text has to be
  // captured rather than returned.
  const { help } = await import('../src/commands/help.mjs');
  const chunks = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let code;
  try {
    code = await help(['help']);
  } finally {
    process.stdout.write = real;
  }
  assert.equal(code, EXIT.OK);
  const text = chunks.join('');
  assert.ok(text.length > 200, 'help produced nothing to check');
  assertClean('simt-dev help', text);
  // It previously said "for the SIMT ecosystem", which is the same assumption as a
  // repository name in a projected rule, one level up.
  assert.ok(!/\bSIMT\b/.test(text), 'help claims the tool belongs to one estate');
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
  for (const file of await adrFiles()) {
    const text = await readFile(join(DECISIONS_DIR, file), 'utf8');
    const m = /\bsimt (?!-dev\b)(?:sync|check|init|doctor|skills|rules|hooks|compare|upgrade|mcp|graph)\b/.exec(text);
    assert.equal(m, null, `${file} tells the reader to run a command that does not exist: ${m?.[0]}`);
  }
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

async function adrFiles() {
  return (await readdir(DECISIONS_DIR)).filter((n) => /^ADR-\d{3}-.*\.md$/.test(n)).sort();
}
