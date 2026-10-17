// Kernel mode: a repository that asks for a smaller always-on projection gets one (R07).
//
// The tests below ask three questions of the mode. Does it change anything by default —
// no, `full` is what a repository gets until something has measured that a kernel is
// not worse (plan 0003 R02). When it is switched on, what reaches the reader, and what
// the reader is told is missing. That last one is the test that matters: a rule that was
// left out and named nowhere is a rule the reader cannot find, which is the same defect
// as a rule that was never written.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { desiredRegion, loadRules } from '../src/projection/rules.mjs';
import { budgetFinding, buildManifest, declaredBudget, readManifest } from '../src/projection/manifest.mjs';
import { budgetCutFinding, packToBudget } from '../src/kernel/budget.mjs';
import { KERNEL_CLASSES, PRIORITY_CLASSES } from '../src/projection/rules.mjs';

/** A python repository with three local profiles: one hard, one a command, one a style. */
async function kernelRepo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-kernel-'));
  await mkdir(join(root, '.simt-dev', 'profiles'), { recursive: true });
  await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "x"\n');
  const write = (id, priority, title, lines = 1) =>
    writeFile(
      join(root, '.simt-dev', 'profiles', `${id}.md`),
      `---\nsimt-id: ${id}\nsimt-title: ${title}\nsimt-applies: [python]\nsimt-priority: ${priority}\n---\n\n# ${title}\n\n${Array.from({ length: lines }, (_, i) => `Body for ${id}, line ${i}.`).join('\n\n')}\n`,
    );
  await write('house-rule', 'hard', 'House rule');
  // The second class a kernel packs, and the only one a budget may cut: `hard` is the
  // floor, so without a `command` rule in the fixture there is nothing for the packer to
  // do and every test below would also pass against a packer that cuts nothing at all.
  //
  // Fat on purpose. Naming a cut rule costs the region a line in the deferred section, so
  // a one-line rule costs more to cut than it saves and the region would grow — which is
  // true of this fixture and is why the fixture is not that.
  await write('house-command', 'command', 'House command', 40);
  await write('house-style', 'style', 'House style');
  return root;
}

const declare = async (root, extra) => {
  const manifest = buildManifest({ root, stack: ['python'], sha: 'abc1234', version: '0.2.1' });
  await writeFile(join(root, 'simt.json'), `${JSON.stringify({ ...manifest, ...extra }, null, 2)}\n`);
};

// ------------------------------------------------------------------ the default is no change

test('a repository that declares no mode gets the whole projection', async () => {
  const root = await kernelRepo();
  const desired = await desiredRegion(root, {});
  // Not `full` asserted as a value but as an absence of consequence: a reader who has
  // said nothing gets every rule it had before the mode existed.
  assert.equal(desired.mode, 'full');
  assert.deepEqual(desired.deferred, []);
  assert.doesNotMatch(desired.body, /## Rules not in this region/);
  assert.match(desired.body, /Body for house-style, line 0\./, 'a style-classed rule is still in the region');
  assert.match(desired.body, /Body for house-rule, line 0\./, 'and so is a hard-classed one');
});

test('the manifest carries a mode only when the repository declared one', async () => {
  const root = await kernelRepo();
  assert.equal(buildManifest({ root, stack: ['python'], sha: 'a', version: '0.2.1' }).mode, undefined);

  await declare(root, { mode: 'kernel' });
  const { manifest } = await readManifest(root);
  const rebuilt = buildManifest({ root, stack: ['python'], sha: 'a', version: '0.2.1', existing: manifest });
  assert.equal(rebuilt.mode, 'kernel', 'an upgrade must not reset the repository to full');
});

// ------------------------------------------------------------------ what the kernel keeps

test('kernel mode packs the hard and command classes and defers the rest', async () => {
  const root = await kernelRepo();
  await declare(root, { mode: 'kernel' });
  const desired = await desiredRegion(root, {});

  assert.equal(desired.mode, 'kernel');
  // The shipped `python` profile declares `convention` (S50's work gave every stack
  // profile a class), so it leaves too. Asserted rather than assumed: a kernel that
  // kept the stack profiles would keep most of the bytes this mode exists to shed.
  assert.deepEqual(desired.deferred.sort(), ['house-style', 'python']);

  const body = desired.body;
  assert.match(body, /Body for house-rule, line 0\./, 'a hard constraint is the whole point of a kernel');
  assert.doesNotMatch(body, /Body for house-style, line 0\./, 'a style rule is the first thing a kernel drops');

  // The shipped python profile declares `convention`, so it leaves too — and the region
  // has to say so, by name and by the command that shows it.
  assert.match(body, /## Rules not in this region/);
  assert.match(body, /house-style/);
  assert.match(body, /rules show house-style/, 'a deferred rule that is not named is a rule lost');
  for (const id of desired.deferred) {
    assert.match(body, new RegExp(`rules show ${id}`));
    assert.match(desired.meta.sources.length > 0 ? body : '', new RegExp(id));
  }
});

test('a rule that states no class is deferred, because keeping it would defeat the mode', async () => {
  const root = await kernelRepo();
  await writeFile(
    join(root, '.simt-dev', 'profiles', 'unclassified.md'),
    '---\nsimt-id: unclassified\nsimt-title: Unclassified\nsimt-applies: [python]\n---\n\n# Unclassified\n\nNo class at all.\n',
  );
  await declare(root, { mode: 'kernel' });
  const desired = await desiredRegion(root, {});
  assert.ok(desired.deferred.includes('unclassified'));
  assert.doesNotMatch(desired.body, /No class at all\./);
  // It is named as unclassified rather than as a class it never declared.
  assert.match(desired.body, /unclassified/);
});

// ------------------------------------------------------------------ the classes themselves

test('an unknown priority class is a defect, not a class nobody happened to use', async () => {
  const root = await kernelRepo();
  await writeFile(
    join(root, '.simt-dev', 'profiles', 'wrong.md'),
    '---\nsimt-id: wrong\nsimt-title: Wrong\nsimt-applies: [python]\nsimt-priority: critical\n---\n\n# Wrong\n\nA class that does not exist.\n',
  );
  // Reported where defects are reported — `graph lint` and `check` — not in the region,
  // which renders whatever a rule says and says nothing about whether it is well formed.
  const rules = await loadRules(root);
  const wrong = rules.find((r) => r.id === 'wrong');
  assert.match(wrong.error, /simt-priority is "critical"/, 'the defect names the value');
  assert.match(wrong.error, /hard, command, convention, style/, 'and the vocabulary it must come from');
});

test('the kernel is the two classes that cost a reader nothing to skip', () => {
  // Asserted as the set rather than as behaviour: every other test depends on what is
  // inside it, and a class that drifts into the kernel defers less than it claims to.
  assert.deepEqual([...KERNEL_CLASSES].sort(), ['command', 'hard']);
  assert.equal(PRIORITY_CLASSES[0], 'hard');
  assert.equal(PRIORITY_CLASSES.length, 4);
});

// ------------------------------------------------------------------ the budget reading it

test('a kernel over the line says the kernel is over the line', async () => {
  const full = budgetFinding(40_000, { bytes: 30_000 });
  assert.match(full.detail, /full mode/);
  assert.match(full.remedy, /switch mode to kernel/);

  const kernel = budgetFinding(40_000, { bytes: 30_000 }, 'kernel');
  assert.match(kernel.detail, /kernel mode/);
  assert.match(
    kernel.detail,
    /not a projection waiting to be trimmed/,
    'in kernel mode the projection is already as small as this mode makes it',
  );
  // The remedy a reader can act on differs by mode, which is the whole reason the
  // finding takes the mode at all.
  assert.match(kernel.remedy, /convention or style/);
  assert.notEqual(full.remedy, kernel.remedy, 'the two modes cannot be given the same advice');
});

test('a projection inside its declared budget produces no finding in either mode', () => {
  assert.equal(budgetFinding(29_999, { bytes: 30_000 }), null);
  assert.equal(budgetFinding(29_999, { bytes: 30_000 }, 'kernel'), null);
  // The default stands in for a repository that declared nothing.
  assert.equal(budgetFinding(29_999, undefined), null);
});

// ------------------------------------------------------------- the budget cutting for it

test('the budget is one number with one reader, and a typo is not a number', () => {
  assert.equal(declaredBudget({ budget: { bytes: 12_345 } }), 12_345);
  assert.equal(declaredBudget({}), 30_000, 'a repository that declared nothing gets the review figure');
  // Zero is a decision somebody can make — "this repository wants an empty projection" —
  // and treating it as absent would silently hand them the default instead.
  assert.equal(declaredBudget({ budget: { bytes: 0 } }), 0);
  // A manifest is hand-edited, and every one of these is a typo rather than a ceiling.
  // Falling back to the default is the only reading that cannot make every comparison
  // against the ceiling pass because the ceiling is the string `'soon'`.
  for (const bad of [null, 'soon', -1, Number.NaN]) {
    assert.equal(declaredBudget({ budget: { bytes: bad } }), 30_000, `bytes: ${JSON.stringify(bad)}`);
  }
});

test('a kernel over its declared budget is cut, and every cut rule is named with its command', async () => {
  const root = await kernelRepo();
  await declare(root, { mode: 'kernel' });
  const uncut = await desiredRegion(root, {});
  assert.deepEqual(uncut.budget.cuts, [], 'the default budget leaves a kernel alone');

  // One byte under what the region weighs, carrying the same reserve it already charged.
  // Derived from the projection's own numbers rather than from a constant, so the test
  // keeps its meaning when core.md grows or shrinks and does not encode today's sizes.
  await declare(root, {
    mode: 'kernel',
    budget: { bytes: uncut.budget.reserve + uncut.budget.before - 1 },
  });
  const desired = await desiredRegion(root, {});

  assert.ok(desired.budget.cuts.length > 0, 'a region over its ceiling has to give something up');
  assert.equal(desired.budget.floorHeld, false, 'and the cut was enough to reach it');
  // The accept criterion, read off the packer's own arithmetic: whatever it cut, what is
  // left fits. `tokens` measures the same document from disk, and does so in
  // tokens.test.mjs — two definitions of one ceiling is the defect this test exists to
  // keep from coming back.
  assert.ok(
    desired.budget.after <= desired.budget.ceiling,
    `${desired.budget.after} > ${desired.budget.ceiling}`,
  );

  for (const cut of desired.budget.cuts) {
    assert.doesNotMatch(desired.body, new RegExp(`Body for ${cut.id}, line`), `${cut.id} was cut, so its text is gone`);
    // Named, and named with the command that brings it back. A cut line that is not named
    // is indistinguishable from a rule that was never written (ADR-073 ruling 6).
    assert.match(desired.body, new RegExp(`rules show ${cut.id}`));
    // And the line says WHY it is not there. A reader told only "deferred" for a rule that
    // was cut would go looking for a kernel decision that was never made.
    assert.match(desired.body, /cut to fit the declared budget of \d+ bytes/);
  }
  assert.match(desired.body, /Body for house-rule, line 0\./, 'the hard constraint is not what a byte count takes');
});

test('a full projection is never cut, however tight the budget', async () => {
  const root = await kernelRepo();
  await declare(root, { budget: { bytes: 1 } });
  const desired = await desiredRegion(root, {});
  assert.equal(desired.mode, 'full');
  // Null rather than an empty cut list. No ceiling was applied, so there is nothing to
  // report — and a reader of `budget.cuts.length` must not be able to conclude a cut
  // happened when the mode made none possible.
  assert.equal(desired.budget, null);
  assert.match(desired.body, /Body for house-command, line 0\./);
});

test('hard is the floor, and a kernel still over after every cut says so', async () => {
  const root = await kernelRepo();
  // A budget of zero: nothing fits, so everything may be cut that is allowed to be.
  await declare(root, { mode: 'kernel', budget: { bytes: 0 } });
  const desired = await desiredRegion(root, {});

  assert.deepEqual(desired.budget.cuts.map((c) => c.id), ['house-command'], 'all that was cuttable went');
  assert.equal(desired.budget.floorHeld, true, 'and it is still over, which is a different fact');
  assert.match(desired.body, /Body for house-rule, line 0\./, 'a hard constraint is not cut to reach a byte count');
  // Said in the notes `sync` prints, because "the kernel is over the line" with no record
  // of having tried is the sentence a reader cannot act on. ADR-072's kernel finding
  // names the two levers; this says they were used first.
  assert.ok(
    desired.notes.some((n) => /a hard constraint is not cut/.test(n)),
    desired.notes.join(' | '),
  );
  // A ceiling of zero is true and unreadable on its own: it does not say that the files
  // loading beside the region already spent the budget. That repository has one lever, and
  // a reader left to infer it is a reader who demotes a hard rule to fix a number they set
  // too low.
  assert.ok(
    desired.notes.some((n) => /already reach the 0 declared/.test(n)),
    desired.notes.join(' | '),
  );
});

test('two renderings of the same repository are the same bytes', async () => {
  const root = await kernelRepo();
  await declare(root, { mode: 'kernel' });
  const uncut = await desiredRegion(root, {});
  await declare(root, {
    mode: 'kernel',
    budget: { bytes: uncut.budget.reserve + uncut.budget.before - 1 },
  });
  const first = await desiredRegion(root, {});
  const second = await desiredRegion(root, {});

  // What this establishes and what it does not: two runs in one process on one machine
  // catch a packer that leaks between calls — a module-level set, a counter, an iteration
  // order that depends on what ran before. Two machines is the claim R08 actually makes,
  // and no test in this suite can make it; the argument for it is that nothing on the path
  // reads a clock, the network or PATH.
  assert.deepEqual(first.budget.cuts, second.budget.cuts);
  assert.deepEqual(first.budget.after, second.budget.after);
  assert.deepEqual(first.meta.sources, second.meta.sources);
  assert.equal(first.body, second.body);
});

// -------------------------------------------------------------- the packer on its own

test('the packer cuts in the order it was handed and stops at the floor', () => {
  const candidates = [
    { id: 'a', priority: 'command' },
    { id: 'b', priority: 'hard' },
    { id: 'c', priority: 'command' },
  ];
  // A cost that is a plain function of what was cut, so the assertion is about the
  // packer's decisions rather than about how big any rule happens to be today.
  const costs = (cut) => 1_000 - [...cut].length * 100;

  // 1,000 over an 800 ceiling: `a` goes, `b` is skipped as hard, `c` goes, 800 fits.
  const fits = packToBudget({ candidates, ceiling: 800, costs });
  assert.deepEqual(fits.cut, ['a', 'c'], 'the hard rule in the middle was skipped, not cut');
  assert.equal(fits.after, 800);
  assert.equal(fits.floorHeld, false);

  // The same cut set cannot reach 500, and that is a fact about the repository rather
  // than a packer that gave up — which is why it is reported at all.
  const short = packToBudget({ candidates, ceiling: 500, costs });
  assert.deepEqual(short.cut, ['a', 'c']);
  assert.equal(short.after, 800, 'and 800 is what it still weighs, which is why 500 was unreachable');
  assert.equal(short.floorHeld, true);

  // A ceiling nobody needs is not a cut.
  const slack = packToBudget({ candidates, ceiling: 5_000, costs });
  assert.deepEqual(slack.cut, []);
  assert.equal(slack.before, 1_000);
  assert.equal(slack.after, 1_000);
});

test('the cut is reported with the numbers a reader needs to judge it', () => {
  const finding = budgetCutFinding({
    file: 'AGENTS.md',
    bytes: 30_000,
    reserve: 11_305,
    before: 33_120,
    after: 29_640,
    cuts: [{ id: 'slice-commit', priority: 'command' }],
  });
  assert.equal(finding.status, 'budget-cut');
  assert.match(finding.detail, /^BUDGET-CUT: /);
  // Before, after, declared and the reserve, because a reader told only "over budget"
  // cannot tell whether the number is worth a commit — and cannot tell whose files the
  // rest of the budget went to.
  assert.match(finding.detail, /33120 to 29640 bytes against a declared budget of 30000/);
  assert.match(finding.detail, /11305 bytes reserved/);
  // Every rule that left, by id and by class.
  assert.match(finding.detail, /slice-commit \(command\)/);
  // And a remedy that is a decision, not a place to go and look — naming the budget that
  // would have admitted the uncut region. `before` alone would not: 33,120 less the 11,305
  // already held back is 21,815, which is under the region the reader would still get, so
  // following that number leaves the cut exactly where it was.
  assert.match(finding.remedy, /raise budget\.bytes to 44425/);
  assert.match(finding.remedy, /rules show <id>/);
});