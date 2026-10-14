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
import { budgetFinding, buildManifest, readManifest } from '../src/projection/manifest.mjs';
import { KERNEL_CLASSES, PRIORITY_CLASSES } from '../src/projection/rules.mjs';

/** A python repository with two local profiles, one hard and one a convention. */
async function kernelRepo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-kernel-'));
  await mkdir(join(root, '.simt-dev', 'profiles'), { recursive: true });
  await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "x"\n');
  const write = (id, priority, title) =>
    writeFile(
      join(root, '.simt-dev', 'profiles', `${id}.md`),
      `---\nsimt-id: ${id}\nsimt-title: ${title}\nsimt-applies: [python]\nsimt-priority: ${priority}\n---\n\n# ${title}\n\nBody for ${id}.\n`,
    );
  await write('house-rule', 'hard', 'House rule');
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
  assert.doesNotMatch(desired.body, /## Deferred rules/);
  assert.match(desired.body, /Body for house-style\./, 'a style-classed rule is still in the region');
  assert.match(desired.body, /Body for house-rule\./, 'and so is a hard-classed one');
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
  assert.match(body, /Body for house-rule\./, 'a hard constraint is the whole point of a kernel');
  assert.doesNotMatch(body, /Body for house-style\./, 'a style rule is the first thing a kernel drops');

  // The shipped python profile declares `convention`, so it leaves too — and the region
  // has to say so, by name and by the command that shows it.
  assert.match(body, /## Deferred rules/);
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