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
import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { sliceCommand } from '../src/commands/slice.mjs';
import { reindex } from '../src/index/store.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';
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
  await copyFile(new URL('../simt.json', import.meta.url), join(root, MANIFEST_FILE));
  await mkdir(join(root, 'docs', 'reviews'), { recursive: true });
  const tracker = join(root, 'docs', 'reviews', '0004-audit-remediation.md');
  await copyFile(new URL('../docs/reviews/0004-audit-remediation.md', import.meta.url), tracker);
  await writeFile(join(root, 'a.mjs'), 'export const a = 1;\n');
  await git(['init', '-q', root]);
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial'], { cwd: root });
  await reindex(root);
  return { root, tracker };
}

test('a failed worktree add releases the lease it claimed (A26)', async () => {
  const { root } = await startableRepo();
  const blocked = join(root, '.simt', 'local', 'worktrees', 'a26');
  await mkdir(blocked, { recursive: true });
  await writeFile(join(blocked, 'occupied'), 'x\n');

  const first = await capture(() => sliceCommand('start', ['A26'], { root, yes: true, session: 'tester' }));
  assert.notEqual(first.code, 0);
  assert.match(first.stderr, /worktree could not be created/);

  // The lease is the claim that has to go with the tree: with the obstruction removed,
  // the same session can start the slice again only if the first attempt released it.
  await rm(blocked, { recursive: true, force: true });
  const second = await capture(() => sliceCommand('start', ['A26'], { root, yes: true, session: 'tester' }));
  assert.equal(second.code, 0, second.stderr);
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
