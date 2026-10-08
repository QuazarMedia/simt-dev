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

import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadRules, select, LOCAL_PROFILE_DIR } from '../src/projection/project.mjs';
import { DECISIONS_DIR } from '../src/decisions/index.mjs';
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

// Every profile in the repo, so adding one cannot opt out of these checks.
const PROFILES = ['node', 'python', 'jvm-android', 'connectiq', 'cloudflare-workers', 'react-web', 'container'];

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
  // The command it tells them to run must exist under the shipped name. This line
  // ships into every consumer's AGENTS.md, so it is the one instruction with no
  // second chance: a reader has only this repo to go on. `sync` previews unless
  // told to write (ADR-035), so the bare spelling would tell them to run it and
  // watch nothing happen — an instruction that was correct when written and false
  // the moment the preview became the default.
  assert.match(text, /simt-dev sync --yes/, text);
  assert.doesNotMatch(text, /simt-dev sync`/, text);
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
  const WRITES = /(?:simt-dev sync|simt-dev hooks install)\b/g;
  const AUTHORISES = /--yes\b|--check\b/;
  const offenders = [];

  for (const file of await collect(join(ROOT, 'src'), '.mjs')) {
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
  assert.match(shim, /simt-dev hooks install --yes/, shim.slice(0, 400));
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
    ['invented.md', 'simt-id: c\nsimt-applies: [node]\npriority: high\n'],
  ]) {
    await writeFile(join(root, LOCAL_PROFILE_DIR, name), `---\n${fm}---\n\nBody.\n`);
  }

  const local = (await loadRules(root)).filter((r) => r.origin === 'local');
  const byFile = new Map(local.map((r) => [r.file, r.error]));
  assert.match(byFile.get('applies.md'), /"applies".*spelled "simt-applies"/);
  // The camelCase spelling is the branch worth asserting: `fallback` is one keystroke
  // from `simt-fallback` and nothing else tells the reader which half is missing.
  assert.match(byFile.get('fallback.md'), /"fallback".*spelled "simt-fallback"/);
  assert.match(byFile.get('invented.md'), /unrecognised frontmatter key "priority"/);
});

async function adrFiles() {
  return (await readdir(DECISIONS_DIR)).filter((n) => /^ADR-\d{3}-.*\.md$/.test(n)).sort();
}

/** Every file under `dir` with the given extension, sorted, so a failure names a path. */
async function collect(dir, ext) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full, ext)));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out.sort();
}
