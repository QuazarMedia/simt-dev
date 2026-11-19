import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { commandRoot, implicitRoot } from '../src/repo-root.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, keepTemp } from './fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('a flag outranks a positional, and both outrank the current directory', () => {
  // The precedence is a contract: `simt status --root A B` must answer A on every
  // command, not A on some and B on others (review 0003 Q65).
  assert.equal(commandRoot({ root: '/flag' }, ['/positional']), '/flag');
  assert.equal(commandRoot({}, ['/positional']), '/positional');
  assert.equal(commandRoot({}, []), process.cwd());
});

test('the answer is the path the caller wrote, not a resolved one', () => {
  // Commands report the root they were given; normalising here would make `--root .`
  // print an absolute path a reader never typed, and a caller that wants an absolute
  // path says so itself.
  assert.equal(commandRoot({ root: '.' }, []), '.');
});

test('no command keeps its own copy of the precedence', () => {
  // Thirty-four copies is how `args[0]` and `positional[0]`, resolved and unresolved,
  // came to disagree about the same argv.
  const files = execFileSync('grep', ['-rl', 'flags.root ?? ', 'src/'], { cwd: root, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((file) => file !== 'src/repo-root.mjs' && file !== 'src/workspace.mjs' && file !== 'src/commands/upgrade.mjs');
  const offenders = files.filter((file) => /flags\.root \?\? (process\.cwd|positional\[0\] \?\?|args\[0\] \?\?)/.test(readFileSync(root + file, 'utf8')));
  assert.deepEqual(offenders, [], 'commands that resolve their own root');
});

async function gitRepo(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  keepTemp(root);
  await git(['init', '-q', '-b', 'main', '.'], { cwd: root });
  await mkdir(join(root, 'src', 'deep'), { recursive: true });
  await git(['add', '-A'], { cwd: root });
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: root });
  return root;
}

async function from(dir, body) {
  const before = process.cwd();
  try {
    process.chdir(dir);
    return await body();
  } finally {
    process.chdir(before);
  }
}

test('PR09: with no root named, the answer is the repository the directory is in', async () => {
  const root = await gitRepo('simt-root-');
  const top = await realpath(root);
  await from(join(root, 'src', 'deep'), async () => {
    assert.equal(commandRoot({}, []), top, 'a nested cwd is not a root');
    assert.equal(implicitRoot(), top);
    assert.equal(commandRoot({ root: '.' }, []), '.', 'an explicit root stays the path the caller wrote');
    assert.equal(commandRoot({}, ['src']), 'src');
  });
});

test('PR09: a path containing whitespace resolves the same way', async () => {
  const root = await gitRepo('simt root ');
  const top = await realpath(root);
  await from(join(root, 'src'), async () => {
    assert.equal(commandRoot({}, []), top);
  });
});

test('PR09: a linked worktree is its own root', async () => {
  const root = await gitRepo('simt-root-wt-');
  const linked = `${root}-linked`;
  keepTemp(linked);
  await git(['worktree', 'add', '--detach', linked, 'HEAD'], { cwd: root });
  await mkdir(join(linked, 'src', 'deep'), { recursive: true });
  const top = await realpath(linked);
  await from(join(linked, 'src', 'deep'), async () => {
    assert.equal(commandRoot({}, []), top, 'the worktree, never the checkout beside it');
  });
});

test('PR09: the CLI run from a nested directory reports the repository root', async () => {
  const root = await gitRepo('simt-root-both-');
  const top = await realpath(root);
  const bin = fileURLToPath(new URL('../bin/simt.mjs', import.meta.url));
  await from(join(root, 'src', 'deep'), async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [bin, 'status', '--json'], {
      cwd: process.cwd(),
      maxBuffer: 16 << 20,
    });
    assert.equal(JSON.parse(stdout).root, top, 'the command reported the directory it started in');
  });
});
