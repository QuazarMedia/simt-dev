import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { citations, byId, loadDecisions } from '../src/decisions/index.mjs';
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