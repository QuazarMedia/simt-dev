// PT02: what a push carries — the commit count summed across its branch refs and the
// files those commits change — with a fail-closed full-suite reason for every push the
// threshold cannot count (new branch, no upstream, no new commits, unreadable refs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { git, keepTemp, tempDir } from './fixture.mjs';
import { gitText } from '../src/sys/git.mjs';
import { focusedPush } from '../src/hooks/focused-push.mjs';
import { ZERO_SHA } from '../src/hooks/push-skip.mjs';

/** A scratch repository with the identity fixture's git carries. */
async function makeRepo(prefix = 'simt-focused-push-') {
  const root = await tempDir(prefix);
  keepTemp(root);
  await git(['init', '-q', '.'], { cwd: root });
  return root;
}

async function commit(root, name, message) {
  await writeFile(join(root, name), `${message}\n`);
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', message], { cwd: root });
}

const head = (root) => gitText(root, ['rev-parse', 'HEAD']);

/** One pre-push stdin line: `<local ref> <local sha> <remote ref> <remote sha>`. */
const line = (branch, localSha, remoteSha) => `refs/heads/${branch} ${localSha} refs/heads/${branch} ${remoteSha}\n`;

test('a 1-commit push returns one commit and its files', async () => {
  const root = await makeRepo();
  await commit(root, 'a.js', 'one');
  const shaA = await head(root);
  await commit(root, 'b.js', 'two');
  const shaB = await head(root);

  const result = await focusedPush(root, line('main', shaB, shaA));
  assert.equal(result.fullSuite, null);
  assert.equal(result.commits, 1);
  assert.deepEqual(result.files, ['b.js']);
});

test('a 2-ref push sums commits and files across both refs', async () => {
  const root = await makeRepo();
  await commit(root, 'a.js', 'one');
  const shaA = await head(root);
  await commit(root, 'b.js', 'two');
  const shaB = await head(root);
  await git(['checkout', '-qb', 'feat'], { cwd: root });
  await commit(root, 'c.js', 'three');
  await commit(root, 'd.js', 'four');
  const shaD = await head(root);

  const stdin = line('main', shaB, shaA) + line('feat', shaD, shaB);
  const result = await focusedPush(root, stdin);
  assert.equal(result.fullSuite, null);
  assert.equal(result.commits, 3);
  assert.deepEqual(result.files, ['b.js', 'c.js', 'd.js']);
});

test('a new-branch push fails closed to the full suite', async () => {
  const root = await makeRepo();
  await commit(root, 'a.js', 'one');
  const shaA = await head(root);

  const result = await focusedPush(root, line('main', shaA, ZERO_SHA));
  assert.equal(result.commits, 0);
  assert.deepEqual(result.files, []);
  assert.match(result.fullSuite, /new branch/);
});

test('a push with no new commits fails closed to the full suite', async () => {
  const root = await makeRepo();
  await commit(root, 'a.js', 'one');
  const shaA = await head(root);

  const result = await focusedPush(root, line('main', shaA, shaA));
  assert.equal(result.commits, 0);
  assert.deepEqual(result.files, []);
  assert.match(result.fullSuite, /no new commits/);
});

test('an unreadable ref list fails closed to the full suite', async () => {
  const root = await makeRepo();
  await commit(root, 'a.js', 'one');

  const result = await focusedPush(root, 'not a ref list\n');
  assert.equal(result.commits, 0);
  assert.match(result.fullSuite, /no readable ref list/);
});

test('a manual run with no upstream fails closed to the full suite', async () => {
  const root = await makeRepo();
  await commit(root, 'a.js', 'one');

  const result = await focusedPush(root, undefined);
  assert.equal(result.commits, 0);
  assert.deepEqual(result.files, []);
  assert.match(result.fullSuite, /no upstream/);
});

test('a manual run counts the branch against its upstream', async () => {
  const root = await makeRepo('simt-focused-push-upstream-');
  await commit(root, 'a.js', 'one');
  const branch = (await gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

  const remoteRoot = await tempDir('simt-focused-push-remote-');
  keepTemp(remoteRoot);
  await git(['init', '-q', '--bare', '.'], { cwd: remoteRoot });
  await git(['remote', 'add', 'origin', remoteRoot], { cwd: root });
  await git(['push', '-qu', 'origin', branch], { cwd: root });

  await commit(root, 'b.js', 'two');
  const result = await focusedPush(root, undefined);
  assert.equal(result.fullSuite, null);
  assert.equal(result.commits, 1);
  assert.deepEqual(result.files, ['b.js']);
});
