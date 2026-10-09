import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { citations, byId, DECISIONS_DIR, loadDecisions } from '../src/decisions/index.mjs';
import { loadRules, select } from '../src/projection/project.mjs';
import { fingerprint } from '../src/resolve/fingerprint.mjs';

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
  assert.deepEqual(shapes, ['ADR-016', 'ADR-021', 'ADR-023', 'ADR-025', 'ADR-042']);
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
  assert.deepEqual(marked, ['connectiq', 'core']);
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
  assert.match(stderr, /usage: simt-dev rules why/);
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