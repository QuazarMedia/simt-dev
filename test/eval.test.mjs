// The gold corpus: real tasks against real repository signals, with the skills that
// ought to come back.
//
// Plan 0002 section 9 lists `simt skills eval` as a command that "reports precision
// and recall and fails on regression". Review 0001 named the absence in S04 ("plan
// 0002 section 11 step 5 claims an eval corpus that does not exist; see S19") and
// every ranking change since has been argued from examples rather than measured. The
// corpus and the command now both exist, and this file is the gate that keeps them
// honest: it scores the same corpus through the same module the command uses
// (src/resolve/eval.mjs), so what CI asserts and what a reader is shown cannot drift
// apart (ADR-002).
//
// The corpus lives under `test/` on purpose: it is test data, and `test/` is not in
// the published files. The provenance digest walks `rules/` only (ADR-061), so its
// location cannot move the content digest, and an installed copy ships no corpus at
// all - `skills eval` there takes an explicit path to a reader's own gold cases.
//
// A case states `select` (must come back) and `reject` (must not). Asserting an exact
// selection would be brittle in a way that discourages the next person from adding a
// case, and would fail on a change that made the resolver *better*. Asserting only
// presence would not notice a resolver that returned everything, so `reject` is half
// the corpus.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { unknownSkills, scoreCorpus } from '../src/resolve/eval.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(await readFile(resolve(ROOT, 'graph', 'skills.graph.json'), 'utf8'));
const corpus = JSON.parse(await readFile(resolve(ROOT, 'test', 'fixtures', 'eval-corpus.json'), 'utf8'));

const BIN = resolve(ROOT, 'bin', 'simt.mjs');
const exec = promisify(execFile);

// Scored once, through the same function `simt skills eval` calls: a second copy of
// the arithmetic here would be the defect this file is meant to prevent.
const SCORE = scoreCorpus(registry, corpus);

test('eval: every case names skills the registry actually has', () => {
  // A corpus that cites a renamed skill is a corpus that has quietly stopped running:
  // the case would still pass, because the missing name is in neither list.
  const unknown = unknownSkills(registry, corpus);
  assert.deepEqual(unknown, [], 'corpus names skills the registry does not declare');
});

test('eval: every case selects what it expects', () => {
  for (const c of SCORE.cases) {
    assert.deepEqual(c.missing, [], `${c.name}: expected ${c.missing.join(', ')} to be selected, got ${c.selected.join(', ') || 'nothing'}`);
  }
});

test('eval: every case rejects what it excludes', () => {
  for (const c of SCORE.cases) {
    assert.deepEqual(c.wronglySelected, [], `${c.name}: ${c.wronglySelected.join(', ')} should not have been selected`);
  }
});

test('eval: the corpus measures recall and precision, and both are total', () => {
  // Plan 0002 section 9 asks the command to "report precision and recall and fail on
  // regression". Both are computed here rather than assumed, and neither is allowed to
  // be the kind of number that cannot fail.
  //
  // The first version of this test scored precision against `select + reject` only, and
  // a case where the resolver selected a skill neither list named scored a perfect 1.0.
  // That is not precision, it is agreement with whatever happened to be written down.
  // So precision is measured two ways and both must hold: every named negative stays
  // unselected, and every case whose truth is "nothing" returns nothing at all - the
  // only place the corpus can claim to be exhaustive.
  const exhaustive = [];
  corpus.cases.forEach((c, i) => {
    if (c.select.length === 0) exhaustive.push(SCORE.cases[i]);
  });
  for (const c of exhaustive) {
    assert.deepEqual(c.unexpected, [], `${c.name} expects an empty selection but returned ${c.selected.join(', ')}`);
  }
  assert.equal(SCORE.precision, 1, `precision ${SCORE.precision.toFixed(3)}: ${SCORE.wrong} of ${SCORE.negatives} named negatives were selected`);
  assert.equal(SCORE.recall, 1, `recall ${SCORE.recall.toFixed(3)}: ${SCORE.missed} of ${SCORE.expected} expected selections were missed`);
  assert.ok(exhaustive.length >= 2, `only ${exhaustive.length} cases state an exhaustive answer, so precision rests on named negatives alone`);
});

test('eval: the corpus is wide enough to rank against', () => {
  // A corpus of three generous cases would pass a resolver that selected half the
  // registry. These three floors are the ones that make the numbers above mean something,
  // and each exists because its absence was the failure it now prevents.
  const cases = corpus.cases;
  assert.ok(cases.length >= 10, `the corpus has ${cases.length} cases, which is too few to rank against`);
  assert.ok(cases.some((c) => c.select.length === 0), 'no case expects an empty selection');
  assert.ok(cases.filter((c) => c.select.length > 0).length >= 7, 'too few cases expect a selection');
  // Cases must span ecosystems, or the corpus is three Workers cases wearing different
  // names and the gate is never actually tested.
  const stacks = new Set(cases.flatMap((c) => c.repo.stack ?? []));
  for (const tag of ['gradle', 'kotlin', 'firebase', 'cloudflare-workers']) {
    assert.ok(stacks.has(tag), `the corpus never exercises the ${tag} ecosystem`);
  }
});

test('eval: the brief a reader gets says why, through the shipped binary (S04)', async () => {
  // The corpus calls `rankSkills` directly. A reader runs a command, so the acceptance
  // review 0001 named is asserted of the command: a task of stopwords must select
  // nothing, and the output must say why rather than printing an empty list.
  const root = await mkdtemp(join(tmpdir(), 'simt-eval-'));
  try {
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'w', private: true }) + '\n');
    const { stdout } = await exec('node', [BIN, 'skills', 'brief', '--task', 'fix a typo in the README', '--root', root]);
    assert.match(stdout, /RESOLVED 0 skills/);
    assert.match(stdout, /NOT SELECTED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('eval: `skills find` applies the same selection rule (S04)', async () => {
  // `find` ranks with no repo, so its only rule could have been left as `score > 0` and
  // nothing would have noticed: reverting it that way passes the whole suite, which is
  // what this test was written after. The mutation is observable - "d1" returns one
  // match with the minimum-score rule and two without - so the rule is pinned here
  // rather than assumed to have travelled with the import.
  //
  // The word is chosen because it lands strictly between 0 and MIN_SCORE for exactly one
  // skill: `wrangler` scores 8 through its summary, and `cloudflare` scores 40 through
  // the keyword `d1` it declares.
  const { stdout } = await exec('node', [BIN, 'skills', 'find', 'd1']);
  assert.match(stdout, /^1 match for "d1"/m);
  assert.doesNotMatch(stdout, /^wrangler\s/m);
});
