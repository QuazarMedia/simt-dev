import assert from 'node:assert/strict';
import { cmd } from './fixture.mjs';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { citations, byId, DECISIONS_DIR, loadDecisions, redactInternalPaths } from '../src/decisions/index.mjs';
import { initCommand } from '../src/commands/init.mjs';
import { loadRules, select } from '../src/projection/project.mjs';
import { fingerprint } from '../src/resolve/fingerprint.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt-dev.mjs');
const exec = promisify(execFile);

async function run(args) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], { maxBuffer: 16 << 20 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function scratch(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'simt-rules-'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  return dir;
}

// --- citations ----------------------------------------------------------------

test('citations: extracts, sorts and dedupes ADR ids', () => {
  assert.deepEqual(citations('a (ADR-010) then ADR-002 then ADR-010 again'), ['ADR-002', 'ADR-010']);
});

test('citations: a body with no decision yields an empty list, not a guess', () => {
  assert.deepEqual(citations('# Rules\n\nno decision here'), []);
});

test('citations: does not match a four-digit number as three', () => {
  // ADR-0100 is not a record; matching its prefix would invent provenance.
  assert.deepEqual(citations('ADR-0100 and ADR-01'), []);
});

// --- decision index -----------------------------------------------------------

test('loadDecisions: every record parses with an id, title and status', async () => {
  const { ok, decisions, errors } = await loadDecisions();
  assert.deepEqual(errors, []);
  assert.ok(ok);
  assert.ok(decisions.length >= 13, `expected at least 13 records, got ${decisions.length}`);
  for (const d of decisions) {
    assert.match(d.id, /^ADR-\d{3}$/);
    assert.ok(d.title.length > 0, `${d.id} has no title`);
    assert.ok(d.status.length > 0, `${d.id} has no status`);
  }
});

test('loadDecisions: the status line is readable prose, not raw markdown', async () => {
  const { decisions } = await loadDecisions();
  for (const d of decisions) {
    assert.ok(!d.status.includes(']('), `${d.id} status still carries markdown link syntax: ${d.status}`);
    assert.ok(!d.status.includes('*'), `${d.id} status still carries emphasis markers`);
  }
});

test('loadDecisions: a superseded record says so, and names its successor', async () => {
  const { decisions } = await loadDecisions();
  const index = byId(decisions);
  const eleven = index.get('ADR-011');
  const twelve = index.get('ADR-012');

  assert.ok(eleven, 'ADR-011 must exist: it is retained as the evidence ADR-012 rests on');
  assert.equal(eleven.accepted, false);
  assert.equal(eleven.supersededBy, 'ADR-012');
  assert.deepEqual(twelve.supersedes, ['ADR-011']);
  assert.equal(twelve.accepted, true);
});

test('loadDecisions: every supersededBy points at a record that exists', async () => {
  const { decisions } = await loadDecisions();
  const index = byId(decisions);
  for (const d of decisions) {
    if (!d.supersededBy) continue;
    assert.ok(index.has(d.supersededBy), `${d.id} is superseded by a record that does not exist`);
  }
});

// --- S31: the status is a paragraph, and a partial supersession is a fact ----
//
// Every test below is about one thing the parser could not see. Each of them passed on
// the version that read the status as a single line, because a truncated sentence is
// still a sentence and a merged ruling is still a ruling.

test('the status is the whole paragraph, not the line it starts on', async () => {
  // ADR-023's status wraps over three lines and the last two carry the whole claim:
  // which record superseded ruling 2, and that rulings 3 and 4 were narrowed too.
  // Read as one line it ended at "ruling 2 superseded by", which is a sentence with no
  // object - and the reader's only evidence that a ruling had been overturned.
  const { decisions } = await loadDecisions();
  const index = byId(decisions);
  const d = index.get('ADR-023');
  assert.match(d.status, /superseded by ADR-024, which carves out this/);
  assert.match(d.status, /rulings 3 and 4 narrowed by the same record/);
  assert.ok(
    !d.status.includes('Affects:'),
    'the paragraph must stop at the next field: Affects is a list of paths and this output is read in a repo that owns none of them',
  );
});

test('every partial supersession in the corpus is found, with its kind and its record', async () => {
  const { decisions } = await loadDecisions();
  const byId_ = byId(decisions);
  const shapes = decisions.filter((d) => d.partial.length > 0).map((d) => d.id).sort();
  // Measured before the fix: eight clauses across four records, of which the parser
  // found none. Listed by id rather than by count so a record that stops declaring its
  // supersession is a visible change rather than a smaller number.
  assert.deepEqual(shapes, [
    'ADR-016',
    'ADR-021',
    'ADR-023',
    'ADR-025',
    'ADR-032',
    'ADR-042',
    'ADR-073',
    'ADR-077',
    'ADR-081',
    'ADR-083',
  ]);
  for (const d of decisions) {
    for (const p of d.partial) {
      assert.ok(['superseded', 'narrowed', 'withdrawn'].includes(p.kind), `${d.id}: unknown kind ${p.kind}`);
      if (p.by !== null) {
        assert.ok(byId_.has(p.by), `${d.id} names ${p.by} as superseding a ruling, and there is no such record`);
      }
    }
  }
  // "the same record" is an anaphor, and ADR-023 uses it for rulings 3 and 4 after
  // naming ADR-024 for ruling 2. Resolving it to nothing would drop two of the three.
  assert.deepEqual(byId_.get('ADR-023').partial, [
    { ruling: 2, kind: 'superseded', by: 'ADR-024' },
    { ruling: 3, kind: 'narrowed', by: 'ADR-024' },
    { ruling: 4, kind: 'narrowed', by: 'ADR-024' },
  ]);
  // "one ruling narrowed by" names no number, and that is a fact about the record
  // rather than a gap to fill: it is carried as null and reported as unnumbered.
  assert.deepEqual(byId_.get('ADR-016').partial, [{ ruling: null, kind: 'narrowed', by: 'ADR-045' }]);
  assert.deepEqual(byId_.get('ADR-042').partial, [{ ruling: 1, kind: 'superseded', by: 'ADR-053' }]);
  // ADR-032's coverage claim was narrowed rather than overturned, and the difference is
  // the kind of thing a wrong `superseded`/`narrowed` costs a reader: `narrowed` says the
  // other two rulings still stand, and they are the ones about reading and writing a stamp.
  assert.deepEqual(byId_.get('ADR-032').partial, [{ ruling: 1, kind: 'narrowed', by: 'ADR-054' }]);
});

// --- what travels --------------------------------------------------------------

test('no status line names a location that resolves only inside this package (S54)', async () => {
  // `rules why` output is read inside a repository that owns none of this package's
  // files, and a path that resolves here resolves nowhere there. The review measured two
  // records and called it pre-existing; the corpus says five, and three of them were
  // written after that measurement — so the guard is the corpus, not the count.
  //
  // `existsSync` against the package root is the test: it is the definition of "resolves
  // only here", and it needs no list of directories to go stale.
  const root = resolve(HERE, '..');
  const { decisions } = await loadDecisions();
  for (const d of decisions) {
    for (const token of new Set(d.status.match(/[\w.@/-]*[\w-]+\/[\w./-]+/g) ?? [])) {
      assert.equal(
        existsSync(join(root, token)),
        false,
        `${d.id} prints "${token}" in its status, which resolves inside this package and in no repository that adopts it`,
      );
    }
  }
});

test('the prose locations left in place are counted, so the decision cannot go unnoticed (S54)', async () => {
  // The ruling covers the STATUS line and deliberately not the record's own argument, and
  // the reason is written down rather than assumed: `docs/plans/` means this package's
  // plan in one record and the adopting repository's own plans in another, and redaction
  // would have to guess. `redactEstate` cuts the other way and redacts prose — the
  // difference is that an estate name is never the reader's business either, whereas a
  // path in an argument may legitimately be.
  //
  // So the cost of that decision is a number, not a shrug. Asserting it here means a
  // record that stops quoting a location moves this count, and a record that starts
  // quoting one is visible in the same diff. ADR-055 is on the list for the same reason
  // the others are: the record that explains the ruling quotes the collision it turned on.
  // ADR-058 joined for the same reason, and its addition is this line. The record is
  // ABOUT three files - pyproject.toml, the formula and the two release scripts - and
  // an argument about which file a rule lives in that declines to name any file is not
  // an argument. The paths resolve here and nowhere else, and the ADR ships, so this
  // list is the price of writing a record that has to be located to be understood.
  const root = resolve(HERE, '..');
  const { decisions } = await loadDecisions();
  const leaking = [];
  for (const d of decisions) {
    const prose = [...d.summary.ruled, ...d.summary.rejected].join('\n');
    if ([...new Set(prose.match(/[\w.@/-]*[\w-]+\/[\w./-]+/g) ?? [])].some((t) => existsSync(join(root, t)))) {
      leaking.push(d.id);
    }
  }
  // ADR-080 joined for the same reason as ADR-058 and its addition is this line: the
  // record is ABOUT the vocabulary and has to name the modules that own it, so the paths
  // are its evidence rather than decoration. ADR-081 and ADR-082 name the directories
  // and the template file the tracker reads, which exist in this package and in the
  // repository that adopts it; the count moves because the records have to name them.
  assert.deepEqual(leaking, [
    'ADR-016',
    'ADR-023',
    'ADR-026',
    'ADR-033',
    'ADR-035',
    'ADR-041',
    'ADR-055',
    'ADR-056',
    'ADR-058',
    'ADR-080',
    'ADR-081',
    'ADR-082',
  ]);
});

test('a status line is scrubbed, and a command that travels is not (S54)', () => {
  // The redaction is a predicate over the STATUS line, where every clause is a statement
  // about this package by construction. Prose is left alone, because `docs/plans/` means
  // this package's plan in one record and the reader's own plans in another and no amount
  // of reading the string separates them.
  assert.match(redactInternalPaths('accepted · affects src/resolve/resolve.mjs and graph lint'), /a file in this tool/);
  assert.match(redactInternalPaths('accepted · affects `graph/skills.graph.json`'), /a file in this tool/);
  // `graph lint` is a command the reader can run, and the separator requirement is the
  // only reason it survives a directory that happens to share its name.
  assert.equal(redactInternalPaths('accepted · run: graph lint'), 'accepted · run: graph lint');
  // Paths the reader HAS are not redacted. A gate that names a file the adopting
  // repository owns is doing its job, and scrubbing it would be the opposite defect.
  for (const travels of ['.editorconfig', '.github/workflows/simt-dev-check.yml', MANIFEST_FILE, 'AGENTS.md', 'package.json']) {
    assert.equal(redactInternalPaths(`accepted · affects ${travels}`), `accepted · affects ${travels}`);
  }
});

test('the redaction list is what `init` actually writes, not what a record remembers (S54)', async () => {
  // The predicate exempts three names on the strength of a comment saying they belong to
  // the adopting repository. That comment is a belief, and a belief in a list is a value
  // nobody executes — so it is executed here, against a real adoption.
  //
  // If `init` starts writing a fourth top-level file, this fails and the fix is to add it
  // to the list; if a name on the list stops being written, the redaction is costing a
  // file the reader does have. Either way the list cannot rot silently.
  const root = await scratch({ 'package.json': '{"name":"fx","private":true}\n', 'README.md': '# fx\n' });
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, '.github', 'workflows', 'build.yml'), 'name: build\n');
  assert.equal(await initCommand([root], { yes: true, acceptConflicts: true }), 0);

  const written = (await readdir(root)).filter((n) => !n.startsWith('.'));
  const files = written.filter((n) => n.includes('.'));
  // `package.json` and `README.md` were already there; the tool's own additions are the
  // rest, and every one of them must be a name the predicate exempts.
  const added = files.filter((n) => !['package.json', 'README.md'].includes(n));
  assert.ok(added.includes('AGENTS.md') && added.includes(MANIFEST_FILE), added.join(', '));
  for (const name of added) {
    assert.match(redactInternalPaths(`accepted · affects ${name}`), new RegExp(`^accepted · affects ${name.replace('.', '\\.')}$`),
      `${name} is written into every adopting repository and would be redacted as if it were this package's`);
  }
});

test('a partial supersession never becomes a whole one', async () => {
  // The regression that a correct-looking `supersededBy` regex invites. ADR-023's
  // paragraph contains "ruling 2 superseded by [ADR-024](...)", and an unanchored
  // pattern matches it - after which `rules why` answers the record by printing
  // ADR-024's rulings and suppressing the five in ADR-023 that still stand. Five
  // rulings that the status line itself says stand would have been dropped, by the
  // field that exists to stop exactly that.
  const { decisions } = await loadDecisions();
  const index = byId(decisions);
  assert.equal(index.get('ADR-023').supersededBy, null);
  assert.equal(index.get('ADR-021').supersededBy, null);
  assert.equal(index.get('ADR-016').supersededBy, null);
  assert.equal(index.get('ADR-042').supersededBy, null);
  assert.equal(index.get('ADR-032').supersededBy, null);
  // And the whole-record case still works, because the rule is anchored at the start
  // of the status rather than dropped.
  assert.equal(index.get('ADR-011').supersededBy, 'ADR-012');
  assert.deepEqual(index.get('ADR-012').supersedes, ['ADR-011']);
});

test('accepted is read from the status, not from one record\'s spelling of it', async () => {
  // ADR-001 to ADR-020 wrote `**accepted**` and ADR-021 onwards wrote `accepted`, and
  // the check was `status.includes('**accepted**')`. Fourteen accepted records read as
  // not accepted - the sixth instance in this repository of a check that reads the
  // author's habits rather than the document.
  const { decisions } = await loadDecisions();
  const notAccepted = decisions.filter((d) => !d.accepted).map((d) => d.id);
  assert.deepEqual(notAccepted, ['ADR-011'], 'only a record whose status starts with "superseded" may read as not accepted');
});

test('a ruling that was overturned says so where it is printed', async () => {
  // The reason the annotation exists rather than relying on the status line: an agent
  // reading a ruling is the one who needs to know it is not in force, and the status
  // line is a sentence they have to parse. ADR-023 ruling 2 is the case - ADR-024
  // carved out this repository's own copy, and ruling 2 printed as current is the
  // reversal this module's own header calls "the failure mode of a provenance feature".
  //
  // Asserted on the object rather than on the rendered line: the text between the
  // ruling and its annotation contains a parenthesis, and a pattern that assumed
  // otherwise would be testing the absence of a bracket.
  const { decisions } = await loadDecisions();
  const index = byId(decisions);
  assert.match(index.get('ADR-023').summary.ruled[1], /\(superseded by ADR-024\)$/);
  const twentyFive = index.get('ADR-025').summary.ruled;
  assert.match(twentyFive[0], /\(narrowed by ADR-026\)$/);
  assert.match(twentyFive[1], /\(narrowed by ADR-026\)$/);
  // The rulings that stand carry no annotation, so the marker cannot be mistaken for
  // decoration on everything.
  assert.doesNotMatch(index.get('ADR-023').summary.ruled[0], /\(superseded by/);

  const { code, stdout } = await run(['rules', 'why', 'ADR-023']);
  assert.equal(code, 0);
  assert.match(stdout, /written once and never rewritten[\s\S]*?\(superseded by ADR-024\)/);
});

test('a ruling past the printed excerpt is still named, not only annotated', async () => {
  // Two rulings are printed and a record may have six. ADR-021's overturned ruling is
  // the third, so the annotation cannot reach it and the status line is all that is
  // left - which is why the partial set is also printed as a line of its own.
  const { stdout } = await run(['rules', 'why', 'ADR-021']);
  assert.match(stdout, /partial\s+ruling 3 superseded by ADR-046/);
  const { stdout: out } = await run(['rules', 'why', 'ADR-016']);
  assert.match(out, /partial\s+ruling \(not numbered\) narrowed by ADR-045/);
});

test('a record yields one ruling per ruling it declares, in every family', async () => {
  // Five spellings are in use and one was being read. ADR-045 declares six `**One.**`
  // rulings and printed one merged blob of them; ADR-013 printed the literal text
  // "### 2." to an agent. A supersession names a ruling by number, so a number that
  // cannot be located cannot be reported as no longer in force - the annotation above
  // is only as good as this.
  const { decisions } = await loadDecisions();
  const families = [
    // One row per family, with the numbers it must produce. The numbering is asserted
    // separately from the text because it is the join between a supersession and the
    // ruling it moves: dropping the ordinal from `**One.**` changes no text at all and
    // is caught only here.
    { id: 'ADR-045', numbers: [1, 2], startsWith: 'One.' },
    { id: 'ADR-034', numbers: [1, 2], startsWith: '1.' },
    { id: 'ADR-021', numbers: [1, 2], startsWith: '1.' },
    { id: 'ADR-013', numbers: [1, 2], startsWith: '1.' },
    { id: 'ADR-009', numbers: [null, null], startsWith: 'A skill is a directory' },
  ];
  for (const f of families) {
    const d = byId(decisions).get(f.id);
    assert.ok(d.summary.ruled.length > 0, `${f.id} yields no ruling`);
    assert.ok(
      d.summary.ruled[0].startsWith(f.startsWith),
      `${f.id} ruling 1 does not start with ${f.startsWith}: ${d.summary.ruled[0].slice(0, 60)}`,
    );
    assert.deepEqual(d.summary.rulingNumbers, f.numbers, `${f.id} numbers its rulings wrongly`);
  }
  // The two that matter are the ones that were merged: six declared, one printed.
  const fortyFive = byId(decisions).get('ADR-045');
  assert.match(fortyFive.summary.ruled[1], /^Two\./, 'the second ruling must be the second ruling, not more of the first');
  // ADR-013's heading marker is structure and must not survive into the text.
  for (const d of decisions) {
    for (const r of [...d.summary.ruled, ...d.summary.rejected]) {
      assert.doesNotMatch(r, /^#{1,6} /, `${d.id} hands the reader a markdown heading as a ruling: ${r.slice(0, 60)}`);
      assert.doesNotMatch(r, /```/, `${d.id} hands the reader a fence marker as a ruling`);
    }
  }
  // Every record numbers at least one ruling or is one of the prose records that do
  // not number them at all. A record that suddenly starts numbering is a change in
  // what a supersession can refer to, so the set is pinned rather than counted.
  const unnumbered = decisions
    .filter((d) => d.summary.rulingNumbers.every((n) => n === null))
    .map((d) => d.id);
  assert.deepEqual(
    unnumbered.filter((id) => ['ADR-023', 'ADR-025', 'ADR-021', 'ADR-045'].includes(id)),
    [],
    'a partially superseded record must number its rulings, or the annotation cannot be attached',
  );
});

test('a section ends at the next heading, but not at one inside a code block', async () => {
  // ADR-007's ruling is a document skeleton in a fence, and the skeleton has `##`
  // headings in it. Truncated at the first of them, the record kept only a lead-in -
  // which was still long enough to pass the length check, so the test that asks whether
  // every record yields a ruling passed on a fragment.
  //
  // The fence is below the sentence budget, so the assertion is on the block rather than
  // on the printed excerpt: what matters is that the extractor saw it.
  const { decisions } = await loadDecisions();
  const seven = byId(decisions).get('ADR-007');
  assert.ok(seven.summary.ruled.length > 0, 'ADR-007 must yield a ruling');
  assert.match(seven.summary.ruled[0], /canonical skeleton/i);
  // `## Authority and ownership` is inside the fence, so nothing that is not fence-aware
  // can have read past it.
  assert.doesNotMatch(seven.summary.ruled[0], /Authority and ownership/, 'the printed excerpt is budgeted, so this asserts the cut is downstream of the fence');
  // The lead-in alone is shorter than the excerpt, so the excerpt is more than the
  // lead-in: the text after the fence is in the ruling too.
  assert.ok(
    seven.summary.ruled[0].length > 'One canonical skeleton, sentence case:'.length,
    'the ruling is only the lead-in, so the fence and what follows it were both dropped',
  );
});

// --- catalogue ----------------------------------------------------------------

test('rules list: is sorted by id and shows every rule exactly once', async () => {
  const { code, stdout } = await run(['rules', 'list']);
  assert.equal(code, 0);
  const rules = await loadRules();
  const ids = [...stdout.matchAll(/^\s?(\S+)\s+\d+\.\dk\s+central/gm)].map((m) => m[1]);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
  for (const rule of rules) assert.ok(stdout.includes(rule.id), `${rule.id} missing from the catalogue`);
});

test('rules list: the title column starts at the same offset on every row', async () => {
  // `applies` is the reason this matters: its width is set by the longest signal
  // list, so a hardcoded pad pushed the title out of alignment for exactly the
  // profiles a reader most wants to compare against each other.
  const { code, stdout } = await run(['rules', 'list']);
  assert.equal(code, 0);
  const lines = stdout.split('\n');
  // The header names the title column; every row must start its title exactly
  // there. Measuring against the header rather than a hardcoded index keeps the
  // test honest about what it is protecting.
  const titleColumn = lines.find((l) => l.trimStart().startsWith('id'))?.indexOf('title');
  assert.ok(titleColumn > 0, 'header row not found');
  const rows = lines.filter((l) => /^.?\s+\S+\s+\d+\.\dk\s+central\s+\S/.test(l));
  assert.ok(rows.length >= 8, `expected every rule row, got ${rows.length}`);
  for (const rule of await loadRules()) {
    const row = rows.find((l) => l.trimStart().startsWith(rule.id));
    assert.ok(row, `${rule.id} has no row`);
    // The title begins exactly where the header says it does: the byte before the
    // title is padding, and the byte at the column is the title's first character.
    assert.equal(row[titleColumn - 1], ' ', `no padding before the title column: ${row}`);
    assert.equal(row.slice(titleColumn), rule.title, `title is not at column ${titleColumn}: ${row}`);
  }
});

test('rules list: --root marks exactly the rules that repo selects', async () => {
  const dir = await scratch({
    'monkey.jungle': '# nothing\n',
    'src/main.mc': 'class A {}',
  });
  const { code, stdout } = await run(['rules', 'list', '--root', dir]);
  assert.equal(code, 0);
  const marked = [...stdout.matchAll(/^\*(\S+)/gm)].map((m) => m[1]).sort();
  // The three always-on process rules are marked because they apply to every repository,
  // and this expected set was written while they were invisible to the catalogue (S13).
  // It was accurate about `loadRules` and wrong about the answer: these rules were in
  // this repository's region the whole time, it just could not say so.
  assert.deepEqual(marked, ['connectiq', 'core', 'intake-questions', 'slice-commit', 'test-gate']);
  // `preview-postflight` is opt-in, so no signal selects it — which is the whole reason
  // `simt-opt-in` exists, and the reason the `applies` column now says so.
  assert.ok(!marked.includes('preview-postflight'), 'an opt-in rule must not be marked on a signal alone');
  assert.match(stdout, /preview-postflight\s+\S+\s+per-surface\s+opt-in \(the repo declares it\)/);
});

test('rules list: a repo with no stack still gets core, and says so', async () => {
  const dir = await scratch({ 'notes.txt': 'x' });
  const { stdout } = await run(['rules', 'list', '--root', dir]);
  assert.ok(stdout.includes('*core'));
  assert.ok(stdout.includes('note no profile matched'), 'the note is the honest answer when nothing matched');
});

// --- show ---------------------------------------------------------------------

test('rules show: prints the body and the ADRs it cites', async () => {
  const { code, stdout } = await run(['rules', 'show', 'core']);
  assert.equal(code, 0);
  assert.ok(stdout.includes('## Git'), 'the body must be emitted, not just metadata');
  assert.match(stdout, /adrs\s+ADR-001/);
});

test('rules show: an unknown id exits USAGE and suggests a near match', async () => {
  const { code, stderr } = await run(['rules', 'show', 'pyth']);
  assert.equal(code, 2);
  assert.match(stderr, /did you mean python/);
});

test('rules show: a rule citing no decision says so instead of printing an empty field', async () => {
  const { stdout } = await run(['rules', 'show', 'react-web']);
  assert.match(stdout, /NONE - no decision is cited by this rule/);
});

// --- why: rule direction ------------------------------------------------------

test('rules why: resolves a rule to the decisions that settled it', async () => {
  const { code, stdout } = await run(['rules', 'why', 'python']);
  assert.equal(code, 0);
  assert.match(stdout, /settled by 1 decision/);
  assert.match(stdout, /ADR-006\s+Evidence discipline is central/);
});

test('rules why: a rule with no citation reports the absence as a finding', async () => {
  const { code, stdout } = await run(['rules', 'why', 'container']);
  assert.equal(code, 0);
  assert.match(stdout, /provenance\s+NONE/);
  assert.ok(!stdout.includes('settled by'), 'an uncited rule must not claim provenance');
});

test('rules why: names the rules that share a decision, for blast-radius thinking', async () => {
  const { stdout } = await run(['rules', 'why', 'node']);
  const share = /shares a decision with (.+)/.exec(stdout);
  assert.ok(share, 'expected a shared-decision line');
  assert.ok(share[1].includes('core'), 'core cites ADR-003 and ADR-010 too');
});

test('rules why: a citation with no record is reported, never silently dropped', async () => {
  // The rule list is real content, so the finding is asserted through the pure
  // function rather than by editing a shipped rule file.
  const rule = {
    id: 'probe',
    source: 'rules/probe.md',
    origin: 'central',
    body: 'a rule citing (ADR-999) and ADR-001',
  };
  assert.deepEqual(citations(rule.body), ['ADR-001', 'ADR-999']);
  const { decisions } = await loadDecisions();
  const index = byId(decisions);
  assert.equal(index.get('ADR-999'), undefined, 'the probe citation must be genuinely missing');
});

// --- why: ADR direction --------------------------------------------------------

test('rules why <ADR>: lists the rules that restate a decision', async () => {
  const { code, stdout } = await run(['rules', 'why', 'ADR-010']);
  assert.equal(code, 0);
  assert.match(stdout, /Invoke tools through the repo's own runner/);
  const restates = /restates\s+(.+)/.exec(stdout);
  assert.ok(restates[1].includes('core'), 'core cites ADR-010');
});

test('rules why <ADR>: a superseded record warns rather than handing back a dead ruling', async () => {
  const { code, stdout } = await run(['rules', 'why', 'ADR-011']);
  assert.equal(code, 0, 'a superseded record is not a failure; the supersession rule is working');
  assert.match(stdout, /SUPERSEDED by ADR-012/);
  assert.match(stdout, /retained as evidence, not as policy/);
});

test('rules why <ADR>: an unknown record exits USAGE', async () => {
  const { code, stderr } = await run(['rules', 'why', 'ADR-999']);
  assert.equal(code, 2);
  assert.match(stderr, /no decision record ADR-999/);
});

test('rules why: without an argument it fails rather than guessing a rule', async () => {
  const { code, stderr } = await run(['rules', 'why']);
  assert.equal(code, 2);
  assert.match(stderr, cmd('usage: {cli} rules why'));
});

test('every ADR cited in docs/ is a record that exists', async () => {
  // Plans and reviews used to carry pre-allocated numbers, which is how review
  // 0002 came to cite ADR-027 through ADR-031 for rulings that had nothing to do
  // with the five records those numbers now hold. A citation that resolves is
  // the only property that keeps a review honest as records are written.
  const { decisions } = await loadDecisions();
  const known = new Set(decisions.map((d) => d.id));
  for (const dir of ['plans', 'reviews']) {
    for (const name of await readdir(resolve(HERE, '..', 'docs', dir))) {
      if (!name.endsWith('.md')) continue;
      const path = join(DECISIONS_DIR, '..', dir, name);
      for (const id of citations(await readFile(path, 'utf8'))) {
        assert.ok(known.has(id), `${dir}/${name} cites ${id}, which is not a record`);
      }
    }
  }
});

test('the doc reference sweep is not vacuous', async () => {
  // A sweep that matched nothing would pass forever. docs/plans and docs/reviews
  // are the two directories that cite records; both must cite some.
  let cited = 0;
  for (const dir of ['plans', 'reviews']) {
    for (const name of await readdir(resolve(HERE, '..', 'docs', dir))) {
      if (!name.endsWith('.md')) continue;
      cited += citations(await readFile(join(DECISIONS_DIR, '..', dir, name), 'utf8')).length;
    }
  }
  assert.ok(cited > 0, 'no document cites a record; the sweep above proves nothing');
});

// --- the invariant that matters: selection and provenance agree ---------------

test('every rule that selection can pick names its ADR citations in the catalogue', async () => {
  // A rule with no decision is allowed, but the catalogue must show it as such
  // rather than implying provenance it does not have.
  const { stdout } = await run(['rules', 'list', '--json']);
  const payload = JSON.parse(stdout);
  for (const rule of payload.rules) {
    assert.ok(Array.isArray(rule.adrs), `${rule.id} has no adrs array in --json`);
  }
  const uncited = payload.rules.filter((r) => r.adrs.length === 0).map((r) => r.id);
  assert.ok(uncited.length > 0, 'the corpus is known to contain uncited profiles; this test would be vacuous otherwise');
});

test('select: the rules a repo receives are exactly those its own signals name', async () => {
  const dir = await scratch({ 'pyproject.toml': '[project]\nname="x"\n', Dockerfile: 'FROM node\n' });
  const rules = await loadRules(dir);
  const { stack, facts } = await fingerprint(dir);
  const { selected } = select(rules, stack, facts);
  const ids = selected.map((r) => r.id).sort();
  // container keys on has-dockerfile, python on python: a fact and a tag both select.
  assert.deepEqual(ids, ['container', 'core', 'python']);
});
test('the catalogue sees the per-surface rules, and says where each came from', async () => {
  // The defect: `loadRules` reads `rules/*.md` and `rules/stacks/*.md`, which is every
  // rule that is a *stack profile*. The four per-surface rules are projected by a
  // different call inside `desiredRegion`, so they were in every repository's AGENTS.md
  // and invisible to `rules list`, `rules show` and `rules why` — an agent told to run
  // `simt rules why test-gate` got "no rule with that id" for a rule it was reading.
  const { stdout: list, code } = await run(['rules', 'list']);
  assert.equal(code, 0);
  for (const id of ['intake-questions', 'slice-commit', 'test-gate', 'preview-postflight']) {
    assert.match(list, new RegExp(`^[ *]${id}\\s`, 'm'), `${id} is missing from the catalogue`);
  }

  // `why` on one, end to end, through the shipped binary.
  const { code: whyCode, stdout: why } = await run(['rules', 'why', 'test-gate']);
  assert.equal(whyCode, 0, 'a rule the repository is reading must be resolvable by name');
  assert.match(why, /^test-gate/m);
  assert.match(why, /rules\/mdc\/test-gate\.mdc \(per-surface\)/, 'the source names the file and the kind');

  // And `show` prints a body rather than refusing.
  const { code: showCode, stdout: show } = await run(['rules', 'show', 'intake-questions']);
  assert.equal(showCode, 0);
  assert.ok(show.length > 500, 'a rule body was not printed');

  // The `origin` column distinguishes them from stack profiles. It exists so a reader
  // can tell where a rule came from, and "central" is true of every rule in the package
  // and so says nothing about this distinction.
  assert.match(list, /^[ *]intake-questions\s+\S+\s+per-surface\s/m);
});

test('a per-surface rule is not projected twice by being in the catalogue', async () => {
  // The reason this is fixed in the catalogue and not in `loadRules`: `loadRules` feeds
  // `select`, whose output `desiredRegion` renders into the region, and the per-surface
  // bodies are added separately by `ruleBodies`. Adding them to `loadRules` would put
  // every one of them in the region twice — once as a profile section, once as
  // `## Process:` — which is the duplication ADR-046 exists to prevent.
  //
  // So the assertion is on the rendered region, not on the loader: each body appears
  // exactly once, under the heading the projector gives it.
  const dir = await scratch({ 'package.json': '{"name":"x","scripts":{"test":"true"}}' });
  await run(['sync', '--root', dir, '--yes']);

  const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
  const headings = [...agents.matchAll(/^## Process: (.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(headings.filter((h) => h === 'test-gate' || h === 'slice-commit' || h === 'intake-questions'), ['intake-questions', 'slice-commit', 'test-gate']);

  // Each heading once, and no second copy as a profile section.
  for (const id of ['test-gate', 'slice-commit', 'intake-questions']) {
    assert.equal(
      [...agents.matchAll(new RegExp(`^## Process: ${id}$`, 'gm'))].length,
      1,
      `${id} appears more than once in the region`,
    );
  }
});

test('rules why says when it is printing an excerpt rather than the whole record', async () => {
  // Fifty-five of the sixty records carry more than two rulings, and every one of them
  // printed exactly two — under a header reading "the ruling above is the part that
  // generalises", which is a claim about the two shown and reads as a claim about all of
  // them. A reader looking for a ruling that was never printed concludes it does not
  // exist, which is the failure this whole command exists to prevent.
  //
  // The cap itself is fine; it is a budget, and `--max-bytes` exists. What was wrong is
  // that it did not say so, so "2 of 8" now travels with the answer and names the
  // command carrying the rest.
  const { loadDecisions } = await import('../src/decisions/index.mjs');
  const { decisions } = await loadDecisions();
  const excerpted = decisions.filter((d) => (d.summary.rulingCount ?? d.summary.ruled.length) > d.summary.ruled.length);
  assert.ok(excerpted.length > 20, `expected most records to be excerpted, got ${excerpted.length}`);

  // One of them, end to end through the shipped binary.
  const { code, stdout } = await run(['rules', 'why', excerpted[0].id]);
  assert.equal(code, 0);
  assert.match(stdout, /of \d+ rulings shown/, 'an excerpted record does not say it is one');

  // The pointer names a command that exists, because a remedy that does not run is the
  // defect this file's own corpus checks for in shipped text.
  const pointer = /the rest: (\S+) rules why (\S+) --all\)/;
  const m = pointer.exec(stdout);
  assert.ok(m, 'the excerpt does not name where the rest is');
  assert.equal(m[1], 'simt');
  const shown = await run(['rules', 'why', m[2], '--all']);
  assert.equal(shown.code, 0, 'the command the excerpt points at does not run');
  // And it really does contain the rest, which is the whole reason the pointer exists.
  const total = Number(/of (\d+) rulings shown/.exec(stdout)[1]);
  // Counted inside the `ruled` block only, and not by its numbering: five records
  // number their rulings `**One.**`, `**1. prose**` or leave them unnumbered, so a
  // pattern over the ordinal matches a subset and passes for all.
  const ruledBlock = (shown.stdout.match(/^ruled$\n([\s\S]*?)\n\n/m) ?? [])[1] ?? '';
  assert.equal(
    (ruledBlock.match(/^  - /gm) ?? []).length,
    total,
    'the command the excerpt points at does not print the rulings it promised',
  );

  // A record with exactly two rulings must NOT claim it is an excerpt.
  const whole = decisions.find((d) => (d.summary.rulingCount ?? 0) === d.summary.ruled.length && d.summary.ruled.length >= 2);
  if (whole) {
    const out = await run(['rules', 'why', whole.id]);
    assert.doesNotMatch(out.stdout, /rulings shown/, 'a complete record must not claim to be an excerpt');
  }
});

// --- What a record is said to have been written against -------------------------------
//
// The reader of a citation is in a repository that owns none of the files the record
// cites, and the one field that answers "is any of this about me?" is `writtenAgainst`.
// It was wrong in a way that shipped: `ESTATE_NAME` matched every `simt-` word that was
// not the tool's own name, so the tool's own vocabulary was reported as surveyed
// repositories and redacted into "a repository" in the prose (ADR-080).

test("a name the tool owns is not a repository, and no record names one (ADR-080)", async () => {
  const { loadDecisions } = await import('../src/decisions/index.mjs');
  const { TOOL_WORDS, PREFIX_ARGUING } = await import('../src/toolwords.mjs');
  const { decisions } = await loadDecisions();

  // The vocabulary is derived from the modules that own each name, so it is asserted
  // against those rather than against a copy of them here.
  for (const word of ['simt-id', 'simt-priority', 'simt-inferable-when', 'simt-hooks']) {
    assert.ok(TOOL_WORDS.has(word), `${word} is a name this tool owns and was not in the vocabulary`);
  }
  assert.equal(TOOL_WORDS.has('simt-example'), false, 'a shape that only looks like this tool is a repository');

  const named = [];
  for (const d of decisions) {
    for (const word of d.summary.writtenAgainst) {
      if (word.startsWith('simt-')) named.push(`${d.id} names ${word}`);
    }
  }
  assert.deepEqual(named, [], 'a record reports a name of this tool as a repository it was written against');

  // And the field still does its job: the records that cite the estate cite it by label.
  const estate = decisions.filter((d) => d.summary.writtenAgainst.length > 0);
  assert.ok(estate.length > 0, 'no record names the estate it was written about');
  for (const d of estate) {
    for (const label of d.summary.writtenAgainst) {
      assert.match(label, /^repo-\d{2}$/, `${d.id} names ${label}, which is neither a label nor a name of this tool's`);
    }
  }

  // Each record whose subject is the prefix, or a filename of that shape, cites no
  // repository: the prefixed names in it are the argument. This is the exemption the
  // guard shares, and it is asserted here so a record that stops being about that
  // stops being exempt.
  for (const file of PREFIX_ARGUING.keys()) {
    const d = decisions.find((x) => x.file === file);
    assert.ok(d, `${file} is exempt from the estate rule and is not a record`);
    assert.deepEqual(d.summary.writtenAgainst, [], `${d.id} is exempt as prefix-arguing and still names repositories`);
  }
});

test('redaction removes the estate and keeps the tool (ADR-080)', async () => {
  const { redactEstate } = await import('../src/decisions/index.mjs');
  // Kept: the reader has this word, it is a key they type, and removing it left the
  // ruling about it as "`a repository: hard | command | convention | style`".
  assert.equal(redactEstate('`simt-priority: hard`'), '`simt-priority: hard`');
  assert.equal(redactEstate('the simt-hooks directory'), 'the simt-hooks directory');
  // Removed: a repository the reader cannot open, in a record they can read.
  assert.equal(redactEstate('measured in simt-example'), 'measured in a repository');
  assert.equal(redactEstate('simt-example and repo-14'), 'a repository and a repository');
});
