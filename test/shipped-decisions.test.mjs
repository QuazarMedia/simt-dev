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
import { PREFIX_ARGUING, TOOL_WORDS } from '../src/toolwords.mjs';

import { ROOT, TEXT_EXTENSIONS, collect } from './shipped-fixture.mjs';
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
    .filter((k) => !['key', 'describe'].includes(k) && !/^default(-[a-z0-9-]+)?$/.test(k));
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
// Read from `src/` rather than derived here, because the decision reader needs the same
// answer and two readers answering one question separately is how one of them came to
// report the tool's own `simt-priority` as a surveyed repository (ADR-080). The
// derivation from the modules that own each name lives there, unchanged.
const TOOL_OWN_WORDS = TOOL_WORDS;

/**
 * Records that argue *about* the prefix and therefore have to spell it.
 *
 * Each entry is a file and a reason, never a repository. That is the difference from a
 * list of names and it is the whole point: an exemption says "this document discusses the
 * namespace", which is a fact about this tool and carries nothing about whoever uses it.
 * The rule below catches every repository sharing the prefix, which is the leak; the
 * files listed here are where a prefixed name is the subject, and a generic pattern
 * cannot tell a hypothetical key in an argument from a repository name — `simt-gates`
 * and `simt-api` are the same shape.
 *
 * A stale exemption fails: every entry must still be tripping the rule, so one that stops
 * being needed is removed rather than kept as a precedent.
 */
// The same map the decision reader exempts by, for the same reason: a vocabulary cannot
// settle these two, because the prefixed names in them are the argument.
const PREFIX_ARGUING_RECORDS = Object.fromEntries(PREFIX_ARGUING);

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

const SHIPPED_ROOTS = ['bin', 'src', 'packages/bench/src', 'rules', 'docs/decisions', 'templates', 'agents', 'skills', 'ecosystems', 'harnesses'];
const SHIPPED_FILES = ['CHANGELOG.md', 'README.md', 'LICENSE', 'package.json'];

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
  // A `!` entry in `files` is an exclusion, not a published path: npm reads it as
  // "everything above, minus this one". Counting it as published made this guard fail on
  // an entry that publishes nothing, and dropping the exclusion instead would have
  // shipped the 58 KB index the tarball is supposed to leave out.
  const declared = pkg.files.filter((entry) => !entry.startsWith('!'));
  const guarded = new Set([...SHIPPED_ROOTS, ...SHIPPED_FILES]);
  const shipped = new Set([...declared, ...SHIPPED_FILES]);

  for (const entry of shipped) {
    assert.ok(guarded.has(entry), `${entry} is published by npm and is not guarded. Add it to SHIPPED_ROOTS or SHIPPED_FILES.`);
  }
  for (const entry of guarded) {
    assert.ok(shipped.has(entry), `${entry} is guarded but is not published by npm, so the guard can never fail on it.`);
  }

  // And the wheel, which is the channel that carries the records.
  const pyproject = await readFile(join(ROOT, 'pyproject.toml'), 'utf8');
  assert.match(pyproject, /"docs\/decisions" = "simt_dev\/vendored\/docs\/decisions"/, 'the wheel must ship docs/decisions through force-include');
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

test('a source comment cites a reason or an ADR, never a plan row', async () => {
  // ADR references ship and resolve through `simt rules why ADR-NNN`; `(plan 0003 R40)`
  // resolves to nothing once the plan is archived, and a reader following it in a
  // published file finds no such document (review 0003 Q86).
  const offenders = [];
  for (const file of await collect(join(ROOT, 'src'))) {
    const text = await readFile(file, 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      const trimmed = line.trimStart();
      const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
      if (!isComment) continue;
      // A reference is a plan or review row wherever it appears in the comment: the
      // parenthesised form passed while `Plan 0003 R48. A bare command:` stayed, and that
      // pointer resolves to nothing once the plan is archived just the same.
      if (/\b(?:plan|review)\s+000\d\b|\b[RQ]\d{2}\b/i.test(line)) {
        offenders.push(`${file.replace(`${ROOT}/`, '')}:${i + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
