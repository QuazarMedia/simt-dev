import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { commandRoot } from '../src/repo-root.mjs';

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
