// `simt slice` (review 0003 Q92).
//
// `commands/slice.mjs` drives three states of one worktree - start, finish, abandon - and it
// had no direct test: the slice suite reached it through the binary, so what it refuses
// before touching git was never pinned. That ordering is the contract worth testing: a usage
// error must arrive before a worktree exists, because the alternative is a branch nobody can
// brief and a row still waiting.
//
// The cases here are the ones a caller gets wrong, and each asserts the refusal rather than
// the success path the command suite already covers.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { sliceCommand } from '../src/commands/slice.mjs';
import { parse } from '../src/argv.mjs';
import { reindex } from '../src/index/store.mjs';
import { CLI, MANIFEST_FILE } from '../src/name.mjs';
import { EXIT } from '../src/output/index.mjs';
import { capture, git, tempDir } from './fixture.mjs';

test('every subcommand that needs an id refuses without one, and says what to run', async () => {
  const root = await tempDir('slice-');
  for (const sub of ['start', 'finish', 'abandon']) {
    const result = await capture(() => sliceCommand(sub, [], { root }));
    assert.notEqual(result.code, 0, `${sub} accepted no id`);
    assert.match(result.stderr, new RegExp(`slice ${sub} needs a slice id`), sub);
    assert.match(result.stderr, /run: simt plan next/, sub);
  }
});

test('prompt mode without a prompt is a usage error, not a slice named after nothing', async () => {
  const root = await tempDir('slice-');
  const result = await capture(() => sliceCommand('start', [], { root, dashdash: true }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /needs a prompt after --/);
});

test('an unknown subcommand names the three that exist instead of guessing one', async () => {
  const root = await tempDir('slice-');
  const result = await capture(() => sliceCommand('squash', ['Q1'], { root }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unknown slice subcommand squash/);
  assert.match(result.stderr, /slice start <id> {2}\| {2}simt slice finish <id>/);
});

/**
 * A repository `slice start` can reach the two failure points in: a tracker carrying A26,
 * a manifest, one commit and an index the brief can read.
 */
async function startableRepo() {
  const root = await tempDir('slice-start-');
  // No gates: the finish below must reach the tracker write, not stop at a lint runner a
  // fixture repository does not have.
  await writeFile(join(root, MANIFEST_FILE), JSON.stringify({ id: 'r', stack: [], surfaces: ['cursor'], gates: { preCommit: [], prePush: [] } }));
  await mkdir(join(root, 'docs', 'reviews'), { recursive: true });
  const tracker = join(root, 'docs', 'reviews', '0004-audit-remediation.md');
  await copyFile(new URL('../docs/reviews/archive/0004-audit-remediation.md', import.meta.url), tracker);
  await writeFile(join(root, 'a.mjs'), 'export const a = 1;\n');
  await git(['init', '-q', root]);
  await git(['-C', root, 'config', 'user.email', 'tests@simt.invalid']);
  await git(['-C', root, 'config', 'user.name', 'simt slice tests']);
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial'], { cwd: root });
  await reindex(root);
  return { root, tracker };
}

/** Start A27 and return the main checkout and worktree the pre-committed finish cases use. */
async function startA27() {
  const { root } = await startableRepo();
  const started = await capture(() => sliceCommand('start', ['A27'], { root, yes: true, session: 'tester' }));
  assert.equal(started.code, 0, started.stderr);
  return { root, worktree: join(root, '.simt', 'local', 'worktrees', 'a27') };
}

/** Commit the slice edit and return the commit finish must land. */
async function commitA27(worktree, message = 'feat(a27): commit the slice') {
  await writeFile(join(worktree, 'a.mjs'), 'export const a = 2;\n');
  await git(['-C', worktree, 'add', '-A']);
  await git(['-C', worktree, 'commit', '-qm', message]);
  return String((await git(['-C', worktree, 'rev-parse', 'HEAD'])).stdout).trim();
}

test('a failed worktree add releases the lease it claimed (A26)', async () => {
  const { root } = await startableRepo();
  const blocked = join(root, '.simt', 'local', 'worktrees', 'a26');
  await mkdir(blocked, { recursive: true });
  await writeFile(join(blocked, 'occupied'), 'x\n');

  const first = await capture(() => sliceCommand('start', ['A26'], { root, yes: true, session: 'tester' }));
  assert.notEqual(first.code, 0);
  assert.match(first.stderr, /worktree could not be created/);
  assert.equal(existsSync(join(blocked, 'occupied')), true, 'a pre-existing blocked path was deleted');

  // The lease is the claim that has to go with the tree: with the obstruction removed,
  // the same session can start the slice again only if the first attempt released it.
  await rm(blocked, { recursive: true, force: true });
  const second = await capture(() => sliceCommand('start', ['A26'], { root, yes: true, session: 'tester' }));
  assert.equal(second.code, 0, second.stderr);
});

test('a failed start preserves a slice branch it did not create (A26)', async () => {
  const { root } = await startableRepo();
  await git(['-C', root, 'branch', 'slice/a26']);

  const result = await capture(() => sliceCommand('start', ['A26'], { root, yes: true, session: 'tester' }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /worktree could not be created/);
  const branches = await git(['-C', root, 'branch', '--list', 'slice/a26']);
  assert.match(String(branches.stdout), /slice\/a26/, 'a pre-existing branch was deleted');
});

test('a tracker failure after a commit names the sha and the plan done command (A27)', async () => {
  const { root, tracker } = await startableRepo();
  const started = await capture(() => sliceCommand('start', ['A27'], { root, yes: true, session: 'tester' }));
  assert.equal(started.code, 0, started.stderr);

  const worktree = join(root, '.simt', 'local', 'worktrees', 'a27');
  await writeFile(join(worktree, 'a.mjs'), 'export const a = 2;\n');
  await git(['-C', worktree, 'add', '-A']);

  const reviews = join(root, 'docs', 'reviews');
  await chmod(tracker, 0o444);
  await chmod(reviews, 0o555);
  try {
    const result = await capture(() => sliceCommand('finish', ['A27'], { root, yes: true, test: 'true' }));
    assert.notEqual(result.code, 0, 'the tracker failure was reported as success');
    const output = result.stdout + result.stderr;
    const sha = String((await git(['-C', worktree, 'rev-parse', 'HEAD'])).stdout).trim();
    assert.match(output, new RegExp(sha), 'the committed sha was not reported');
    assert.match(output, new RegExp(`plan done A27 ${sha}`), 'no command records the row');
  } finally {
    await chmod(reviews, 0o755);
    await chmod(tracker, 0o644);
  }
});

test('an unrelated change in the main checkout refuses before any commit, row write or merge', async () => {
  const { root, tracker } = await startableRepo();
  const notes = join(root, 'docs', 'notes.md');
  await writeFile(notes, 'base\n');
  await git(['-C', root, 'add', 'docs/notes.md']);
  await git(['-C', root, 'commit', '-qm', 'notes']);

  const started = await capture(() => sliceCommand('start', ['A27'], { root, yes: true, session: 'tester' }));
  assert.equal(started.code, 0, started.stderr);
  const worktree = join(root, '.simt', 'local', 'worktrees', 'a27');
  await writeFile(join(worktree, 'a.mjs'), 'export const a = 2;\n');
  await git(['-C', worktree, 'add', '-A']);

  // The tracker row is allowed to be dirty; this is the second, unrelated file.
  await writeFile(notes, 'unrelated work in progress\n');
  const mainHead = String((await git(['-C', root, 'rev-parse', 'HEAD'])).stdout).trim();
  const worktreeHead = String((await git(['-C', worktree, 'rev-parse', 'HEAD'])).stdout).trim();
  const trackerBefore = await readFile(tracker, 'utf8');

  const result = await capture(() => sliceCommand('finish', ['A27'], { root, yes: true, test: 'true' }));
  assert.notEqual(result.code, 0, 'an unrelated main-checkout change was accepted');
  assert.match(
    result.stderr,
    new RegExp(
      `^ERROR ${EXIT.USAGE} the main checkout has uncommitted changes \\(docs/notes\\.md\\), so the slice cannot be merged into it$`,
      'm',
    ),
    `the refusal did not name the unrelated file: ${result.stderr}`,
  );

  // Each step before the merge has one state change, so each has one witness: a late
  // guard would move the worktree HEAD (commit), the tracker bytes (row) or main HEAD
  // (merge). A kept branch or worktree and an absent MERGE_HEAD can all be true after a
  // merge attempt, so they do not pin the ordering.
  assert.equal(String((await git(['-C', worktree, 'rev-parse', 'HEAD'])).stdout).trim(), worktreeHead, 'a slice commit was made');
  assert.equal(await readFile(tracker, 'utf8'), trackerBefore, 'the tracker row was written');
  assert.equal(String((await git(['-C', root, 'rev-parse', 'HEAD'])).stdout).trim(), mainHead, 'main moved');
});

test('finish from the main checkout merges the slice, commits the row and removes the worktree', async () => {
  const { root } = await startableRepo();
  const started = await capture(() => sliceCommand('start', ['A27'], { root, yes: true, session: 'tester' }));
  assert.equal(started.code, 0, started.stderr);

  const worktree = join(root, '.simt', 'local', 'worktrees', 'a27');
  await writeFile(join(worktree, 'a.mjs'), 'export const a = 2;\n');
  await git(['-C', worktree, 'add', '-A']);

  const result = await capture(() => sliceCommand('finish', ['A27'], { root, yes: true, test: 'true' }));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /merge\s+[0-9a-f]{40}\s+slice\/a27 -> a27-branch|merge\s+[0-9a-f]{40}\s+slice\/a27 -> /, result.stdout);
  assert.match(result.stdout, /removed\s+\.simt\/local\/worktrees\/a27/, result.stdout);
  assert.match(result.stdout, /deleted\s+slice\/a27/, result.stdout);

  assert.equal(existsSync(worktree), false, 'the worktree survived a finish');
  const branch = await git(['-C', root, 'branch', '--list', 'slice/a27']);
  assert.equal(String(branch.stdout).trim(), '', 'the branch survived a finish');
  assert.equal((await readFile(join(root, 'a.mjs'), 'utf8')).trim(), 'export const a = 2;', 'the slice was not merged');
  const status = await git(['-C', root, 'status', '--porcelain', '--untracked-files=no']);
  assert.equal(String(status.stdout).trim(), '', 'the tracker row was not committed with the merge');
  const log = await git(['-C', root, 'log', '-1', '--format=%s']);
  assert.match(String(log.stdout), /^Merge branch 'slice\/a27'/, 'the slice was not a merge commit');
});

test('finish lands work already committed in the worktree without a second commit', async () => {
  const { root, worktree } = await startA27();
  const message = 'feat(a27): commit the slice in its worktree';
  const committed = await commitA27(worktree, message);

  const preview = await capture(() => sliceCommand('finish', ['A27'], { root, test: 'true' }));
  assert.equal(preview.code, 0, preview.stderr);
  assert.ok(
    preview.stdout.includes(`HEAD ${committed} is already committed; finish lands it`),
    `the dry run did not name the commit it would land: ${preview.stdout}`,
  );

  const result = await capture(() => sliceCommand('finish', ['A27'], { root, yes: true, test: 'true' }));
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(`commit   ${committed}  ${message}`), `the existing commit and its subject were not reported: ${result.stdout}`);
  assert.match(result.stdout, /removed\s+\.simt\/local\/worktrees\/a27/, result.stdout);
  assert.equal(existsSync(worktree), false, 'the worktree survived a finish');
  assert.equal((await readFile(join(root, 'a.mjs'), 'utf8')).trim(), 'export const a = 2;', 'the committed slice was not merged');
  const parents = String((await git(['-C', root, 'log', '-1', '--format=%P'])).stdout).trim().split(' ');
  assert.ok(parents.includes(committed), 'the slice commit is not a parent of the merge');
  assert.equal(String((await git(['-C', root, 'status', '--porcelain', '--untracked-files=no'])).stdout).trim(), '', 'the tracker row was not committed with the merge');
});

test('a commit ahead with a tracked edit still in the worktree refuses to land', async () => {
  const { root, worktree } = await startA27();
  const committed = await commitA27(worktree);
  await writeFile(join(worktree, 'a.mjs'), 'export const a = 3;\n');
  const mainHead = String((await git(['-C', root, 'rev-parse', 'HEAD'])).stdout).trim();

  const result = await capture(() => sliceCommand('finish', ['A27'], { root, yes: true, test: 'true' }));
  assert.equal(result.code, EXIT.USAGE, 'an uncommitted tracked edit was landed with the commit');
  assert.match(
    result.stderr,
    new RegExp(`^ERROR ${EXIT.USAGE} .* has uncommitted changes \\(a\\.mjs\\)$`, 'm'),
    `the refusal did not name the edit: ${result.stderr}`,
  );
  assert.equal(String((await git(['-C', worktree, 'rev-parse', 'HEAD'])).stdout).trim(), committed, 'a second commit was made');
  assert.equal(String((await git(['-C', root, 'rev-parse', 'HEAD'])).stdout).trim(), mainHead, 'the commit was merged anyway');
  assert.equal(existsSync(worktree), true, 'the worktree was removed with the edit still in it');
});

test('a staged edit after the slice commit also refuses to land', async () => {
  const { root, worktree } = await startA27();
  const committed = await commitA27(worktree);
  await writeFile(join(worktree, 'a.mjs'), 'export const a = 3;\n');
  await git(['-C', worktree, 'add', 'a.mjs']);

  const preview = await capture(() => sliceCommand('finish', ['A27'], { root, test: 'true' }));
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /finish refuses: .*has uncommitted changes \(a\.mjs\)/, 'the dry run hid the refusal');

  const result = await capture(() => sliceCommand('finish', ['A27'], { root, yes: true, test: 'true' }));
  assert.equal(result.code, EXIT.USAGE, 'a staged edit after the commit was landed as a second commit');
  assert.match(
    result.stderr,
    new RegExp(`^ERROR ${EXIT.USAGE} .* has uncommitted changes \\(a\\.mjs\\)$`, 'm'),
    `the refusal did not name the staged edit: ${result.stderr}`,
  );
  assert.equal(String((await git(['-C', worktree, 'rev-parse', 'HEAD'])).stdout).trim(), committed, 'a second commit was made');
});

test('finish lands a staged deletion', async () => {
  const { root, worktree } = await startA27();
  await rm(join(worktree, 'a.mjs'));
  await git(['-C', worktree, 'add', '-A']);

  const preview = await capture(() => sliceCommand('finish', ['A27'], { root, test: 'true' }));
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /staged   1 file\(s\)/, preview.stdout);
  assert.doesNotMatch(preview.stdout, /finish refuses/, preview.stdout);

  const result = await capture(() => sliceCommand('finish', ['A27'], { root, yes: true, test: 'true' }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(root, 'a.mjs')), false, 'the staged deletion was not merged');
});

test('the finish dry run reports the same refusal in text and JSON', async () => {
  const { root } = await startA27();
  const text = await capture(() => sliceCommand('finish', ['A27'], { root, test: 'true' }));
  assert.equal(text.code, 0, text.stderr);
  const match = text.stdout.match(/\(finish refuses: (.*)\)$/m);
  assert.ok(match, `the text dry run hid the refusal: ${text.stdout}`);

  const json = await capture(() => sliceCommand('finish', ['A27'], { root, test: 'true', json: true }));
  assert.equal(json.code, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).refusal, match[1], 'the JSON dry run reported a different refusal');
});

test('a clean worktree with no commits ahead refuses to land', async () => {
  const { root, worktree } = await startA27();
  const mainHead = String((await git(['-C', root, 'rev-parse', 'HEAD'])).stdout).trim();
  const result = await capture(() => sliceCommand('finish', ['A27'], { root, yes: true, test: 'true' }));
  assert.equal(result.code, EXIT.USAGE, 'an empty slice was reported as landed');
  assert.match(
    result.stderr,
    new RegExp(`^ERROR ${EXIT.USAGE} .* has nothing staged and no commits ahead of .+$`, 'm'),
    `the refusal did not name both missing contributions: ${result.stderr}`,
  );
  assert.equal(String((await git(['-C', root, 'rev-parse', 'HEAD'])).stdout).trim(), mainHead, 'main moved for an empty slice');
  assert.equal(existsSync(worktree), true, 'the empty worktree was removed');
});

test('a conflicting merge aborts, reports the commit and row, and leaves main usable', async () => {
  const { root, tracker } = await startableRepo();
  const started = await capture(() => sliceCommand('start', ['A27'], { root, yes: true, session: 'tester' }));
  assert.equal(started.code, 0, started.stderr);

  const worktree = join(root, '.simt', 'local', 'worktrees', 'a27');
  await writeFile(join(worktree, 'a.mjs'), 'export const a = 2;\n');
  await git(['-C', worktree, 'add', '-A']);
  // A main commit on the same line the slice changes: the merge has to conflict.
  await writeFile(join(root, 'a.mjs'), 'export const a = 3;\n');
  await git(['-C', root, 'add', 'a.mjs']);
  await git(['-C', root, 'commit', '-qm', 'main change']);
  const mainHead = String((await git(['-C', root, 'rev-parse', 'HEAD'])).stdout).trim();

  const result = await capture(() => sliceCommand('finish', ['A27'], { root, yes: true, test: 'true' }));
  assert.notEqual(result.code, 0, `a conflicted merge was reported as success: ${result.stdout}${result.stderr}`);
  const output = result.stdout + result.stderr;
  const sha = String((await git(['-C', worktree, 'rev-parse', 'HEAD'])).stdout).trim();
  assert.match(output, new RegExp(sha), 'the committed sha was not reported');
  assert.match(output, /row recorded/, 'the row state was not reported');
  assert.match(output, /failed: git merge --no-ff --no-commit slice\/a27 failed/, 'the refusal carried no reason');

  // Aborted, not left half-merged: no MERGE_HEAD, main at its own commit, the file and
  // branch untouched, and the only dirty path is the tracker row recorded before merging.
  assert.equal(existsSync(join(root, '.git', 'MERGE_HEAD')), false, 'the merge was left in progress');
  assert.equal(String((await git(['-C', root, 'rev-parse', 'HEAD'])).stdout).trim(), mainHead, 'main moved');
  assert.equal((await readFile(join(root, 'a.mjs'), 'utf8')).trim(), 'export const a = 3;', 'main work was overwritten');
  assert.match(String((await git(['-C', root, 'branch', '--list', 'slice/a27'])).stdout), /slice\/a27/, 'the slice branch was removed');
  assert.equal(existsSync(worktree), true, 'the slice worktree was removed');
  const status = String((await git(['-C', root, 'status', '--porcelain', '--untracked-files=no'])).stdout);
  assert.deepEqual(status.split('\n').filter((line) => line.trim() !== '').map((line) => line.slice(2).trim()), ['docs/reviews/0004-audit-remediation.md'], 'a merge left more than the row behind');
  const row = (await readFile(tracker, 'utf8')).split('\n').find((line) => line.startsWith('| A27 |'));
  assert.ok(row, 'the A27 row disappeared');
  assert.match(row, new RegExp(`Complete.*${sha}`), 'the row did not record this commit');
});

test('a prompt slice lands without a tracker row', async () => {
  const { root } = await startableRepo();
  const prompt = 'fix the prompt slice helper';
  const started = await capture(() => sliceCommand('start', [prompt], { root, yes: true, dashdash: true, session: 'tester' }));
  assert.equal(started.code, 0, started.stderr);

  const id = 'fix-the-prompt-slice-helper';
  const worktree = join(root, '.simt', 'local', 'worktrees', id);
  await writeFile(join(worktree, 'a.mjs'), 'export const a = 2;\n');
  await git(['-C', worktree, 'add', '-A']);

  const result = await capture(() => sliceCommand('finish', [id], { root, yes: true, test: 'true' }));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /no tracker row/, 'the prompt slice claimed a row');
  assert.equal(existsSync(worktree), false, 'the prompt worktree survived');
  const branch = await git(['-C', root, 'branch', '--list', `slice/${id}`]);
  assert.equal(String(branch.stdout).trim(), '', 'the prompt branch survived');
  assert.equal((await readFile(join(root, 'a.mjs'), 'utf8')).trim(), 'export const a = 2;', 'the prompt slice was not merged');
  const status = String((await git(['-C', root, 'status', '--porcelain', '--untracked-files=no'])).stdout).trim();
  assert.equal(status, '', 'a tracker file was written for a prompt slice');
});

test('a worktree holding untracked files is kept and named', async () => {
  const { root } = await startableRepo();
  const started = await capture(() => sliceCommand('start', ['A27'], { root, yes: true, session: 'tester' }));
  assert.equal(started.code, 0, started.stderr);

  const worktree = join(root, '.simt', 'local', 'worktrees', 'a27');
  await writeFile(join(worktree, 'a.mjs'), 'export const a = 2;\n');
  await git(['-C', worktree, 'add', '-A']);
  await writeFile(join(worktree, 'scratch.txt'), 'not part of the slice\n');

  const result = await capture(() => sliceCommand('finish', ['A27'], { root, yes: true, test: 'true' }));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /kept\s+\.simt\/local\/worktrees\/a27/, 'the kept worktree was not named');
  assert.match(result.stdout, /kept\s+slice\/a27/, 'the kept branch was not named');
  assert.equal(existsSync(join(worktree, 'scratch.txt')), true, 'the untracked file was deleted');
  assert.equal((await readFile(join(root, 'a.mjs'), 'utf8')).trim(), 'export const a = 2;', 'the slice was not merged');
});

test('finish from inside the worktree refuses before it commits anything', async () => {
  const { root } = await startableRepo();
  const started = await capture(() => sliceCommand('start', ['A27'], { root, yes: true, session: 'tester' }));
  assert.equal(started.code, 0, started.stderr);

  const worktree = join(root, '.simt', 'local', 'worktrees', 'a27');
  const before = String((await git(['-C', worktree, 'rev-parse', 'HEAD'])).stdout).trim();
  await writeFile(join(worktree, 'a.mjs'), 'export const a = 2;\n');
  await git(['-C', worktree, 'add', '-A']);

  const result = await capture(() => sliceCommand('finish', ['A27'], { root: worktree, yes: true }));
  assert.notEqual(result.code, 0, 'finishing inside the worktree was accepted');
  assert.match(
    result.stderr,
    new RegExp(`^ERROR ${EXIT.USAGE} run ${CLI} slice finish from the main checkout, not the slice worktree$`, 'm'),
    `the refusal named the wrong checkout: ${result.stderr}`,
  );
  assert.equal(String((await git(['-C', worktree, 'rev-parse', 'HEAD'])).stdout).trim(), before, 'a commit happened anyway');
});

test('a tracker write failure takes the worktree and branch back down (A26)', async () => {
  const { root, tracker } = await startableRepo();
  const reviews = join(root, 'docs', 'reviews');
  // Both halves of the write are blocked: an in-place write needs the file bit, a
  // write-temp-and-rename needs the directory bit.
  await chmod(tracker, 0o444);
  await chmod(reviews, 0o555);
  try {
    const result = await capture(() => sliceCommand('start', ['A26'], { root, yes: true, session: 'tester' }));
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /tracker row was not updated/);
    assert.equal(existsSync(join(root, '.simt', 'local', 'worktrees', 'a26')), false, 'the worktree survived');
    const branches = await git(['-C', root, 'branch', '--list', 'slice/a26']);
    assert.equal(String(branches.stdout).trim(), '', 'the branch survived');
  } finally {
    await chmod(reviews, 0o755);
    await chmod(tracker, 0o644);
  }
});

// Regression: the dry-run apply hint used to print `slice start -- "<prompt>" --yes`.
// After `--`, `--yes` is a positional, so the hinted command dry-ran again - the remedy
// for the refusal was the refusal. The hint must be a command that would apply: `--yes`
// in flag position, the prompt after the marker.
test('the dry-run apply hint is a command that would apply (--yes before --)', async () => {
  const root = await tempDir('slice-hint-');
  const prompt = 'fix the thing with "quotes" inside';
  const result = await capture(() => sliceCommand('start', [prompt], { root, dashdash: true }));
  assert.equal(result.code, 0, `prompt-mode dry run refused: ${result.stderr}`);
  const match = result.stdout.match(/^apply\s+run: (.*)$/m);
  assert.ok(match, 'the dry run printed an apply hint');
  const tokens = tokenizeHint(match[1]);
  const parsed = parse(tokens.slice(tokens.indexOf('start') + 1));
  assert.ok(parsed.ok, `the hinted command does not parse: ${JSON.stringify(parsed.error)}`);
  assert.equal(parsed.value.flags.yes, true, '--yes must reach the flag position');
  assert.equal(parsed.value.flags.dashdash, true, 'the prompt must stay after the -- marker');
  assert.deepEqual(parsed.value.positional, [prompt], 'the prompt is the sole positional');
});

function tokenizeHint(line) {
  const tokens = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '\\') current += line[++i];
      else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (/\s/.test(ch)) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

test('abandon runs to the end: the worktree goes, the row returns to Queued', async () => {
  // The abandon path called `releaseSlice` without importing it, so it crashed after the
  // state work and before releasing the lease. Nothing in the suite drove that branch,
  // which is why the tool reported an error while its effect had already happened.
  const { root, tracker } = await startableRepo();
  const started = await capture(() => sliceCommand('start', ['A26'], { root, yes: true, session: 'tester' }));
  assert.equal(started.code, 0, started.stderr);
  const abandoned = await capture(() => sliceCommand('abandon', ['A26'], { root, yes: true, session: 'tester' }));
  assert.equal(abandoned.code, 0, abandoned.stderr);
  const row = (await readFile(tracker, 'utf8'))
    .split('\n')
    .find((line) => line.startsWith('| A26 '));
  assert.match(row ?? '', /\| Queued \|/, 'the abandoned row did not return to Queued');
  assert.equal(existsSync(join(root, '.simt', 'local', 'worktrees', 'a26')), false);
});
