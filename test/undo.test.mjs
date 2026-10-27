// The write journal and `simt undo` (plan 0003 R49).
//
// The acceptance is the round trip: every write a command records can be
// restored, and only when untouched since. The unit tests below drive the
// journal directly (modify, create, remove); the command tests go through the
// real binary, because that is the only way to catch a writer the dispatcher
// never journals.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  commitJournal,
  journaledCopyDir,
  journaledRemoveFile,
  journaledWriteFile,
  listJournalSets,
  undoLastJournalSet,
} from '../src/journal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);

function git(args, options = {}) {
  return exec(
    'git',
    [
      '-c',
      'user.name=simt-dev tests',
      '-c',
      'user.email=tests@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { maxBuffer: 16 << 20, ...options },
  );
}

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      maxBuffer: 16 << 20,
      env: { ...process.env, NO_COLOR: '1', SIMT_DEV_WORKSPACE: 'off', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function freshRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'simt-undo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(['init', '-q'], { cwd: root });
  return root;
}

test('R49: modify + create + remove round-trips through one journal set', async (t) => {
  const root = await freshRoot(t);
  const kept = join(root, 'kept.md');
  const gone = join(root, 'gone.md');
  await writeFile(kept, 'before\n', 'utf8');
  await writeFile(gone, 'doomed\n', 'utf8');

  const journal = [];
  await journaledWriteFile(root, journal, kept, 'after\n');
  await journaledWriteFile(root, journal, join(root, 'fresh.md'), 'new\n');
  await journaledRemoveFile(root, journal, gone);
  const id = await commitJournal(root, 'test', journal);
  assert.ok(id, 'a run that changed something leaves a set');

  assert.equal(await readFile(kept, 'utf8'), 'after\n');
  assert.equal(await readFile(join(root, 'fresh.md'), 'utf8'), 'new\n');
  await assert.rejects(readFile(gone), 'removed file is gone before undo');

  const result = await undoLastJournalSet(root);
  assert.ok(!('refused' in result && result.refused), 'untouched set restores');
  assert.equal(await readFile(kept, 'utf8'), 'before\n');
  await assert.rejects(readFile(join(root, 'fresh.md')), 'created file is removed by undo');
  assert.equal(await readFile(gone, 'utf8'), 'doomed\n');

  // The undone set is history, not garbage: a second undo finds nothing.
  const again = await undoLastJournalSet(root);
  assert.ok(again.empty, 'an undone set is not restored twice');
});

test('R49: a touched file refuses the whole undo and nothing is restored', async (t) => {
  const root = await freshRoot(t);
  const first = join(root, 'a.md');
  const second = join(root, 'b.md');
  await writeFile(first, 'one\n', 'utf8');
  await writeFile(second, 'two\n', 'utf8');

  const journal = [];
  await journaledWriteFile(root, journal, first, 'ONE\n');
  await journaledWriteFile(root, journal, second, 'TWO\n');
  await commitJournal(root, 'test', journal);

  // Somebody else's edit lands after the journaled run.
  await writeFile(first, 'ONE + hand edit\n', 'utf8');

  const result = await undoLastJournalSet(root);
  assert.ok(result.refused, 'the touched set is refused');
  assert.equal(result.refused.path, 'a.md');
  assert.equal(await readFile(first, 'utf8'), 'ONE + hand edit\n');
  assert.equal(await readFile(second, 'utf8'), 'TWO\n');
  assert.equal((await listJournalSets(root)).length, 1, 'a refused set stays current');
});

test('R49: an empty run commits no set, and an empty undo says so', async (t) => {
  const root = await freshRoot(t);
  assert.equal(await commitJournal(root, 'test', []), null);
  assert.deepEqual(await listJournalSets(root), []);
  const result = await undoLastJournalSet(root);
  assert.ok(result.empty);
});

test('R49: journaledCopyDir restores overwritten trees and removes created ones', async (t) => {
  const root = await freshRoot(t);
  const src = join(root, 'upstream', 'skill');
  await mkdir(join(src, 'refs'), { recursive: true });
  await writeFile(join(src, 'SKILL.md'), 'canonical\n', 'utf8');
  await writeFile(join(src, 'refs', 'notes.md'), 'ref\n', 'utf8');
  const dest = join(root, 'skills', 'graphify');
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, 'SKILL.md'), 'stale\n', 'utf8');

  const journal = [];
  await journaledCopyDir(root, journal, src, dest);
  await commitJournal(root, 'test', journal);
  assert.equal(await readFile(join(dest, 'SKILL.md'), 'utf8'), 'canonical\n');

  const result = await undoLastJournalSet(root);
  assert.ok(!('refused' in result && result.refused));
  assert.equal(await readFile(join(dest, 'SKILL.md'), 'utf8'), 'stale\n');
  await assert.rejects(readFile(join(dest, 'refs', 'notes.md')), 'copied-only file is removed');
});

test('R49: `decide --yes` then `undo --yes` restores the tree through the binary', async (t) => {
  const root = await freshRoot(t);
  const decided = await runCli(['decide', 'Undo me', '--root', root, '--yes']);
  assert.equal(decided.code, 0, decided.stderr.slice(0, 400));
  const afterDecide = await readdir(join(root, 'docs', 'decisions'));
  assert.equal(afterDecide.length, 1, 'the scaffold landed');

  // The preview names the set and writes nothing.
  const preview = await runCli(['undo', '--root', root]);
  assert.equal(preview.code, 0, preview.stderr.slice(0, 400));
  assert.match(preview.stdout, /would restore 1 file/);
  assert.equal((await readdir(join(root, 'docs', 'decisions'))).length, 1);

  const undone = await runCli(['undo', '--root', root, '--yes']);
  assert.equal(undone.code, 0, undone.stderr.slice(0, 400));
  assert.match(undone.stdout, /undone/);
  assert.deepEqual(await readdir(join(root, 'docs', 'decisions')), []);

  // Nothing left to restore: exit 0, not an error.
  const empty = await runCli(['undo', '--root', root, '--yes']);
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /nothing to undo/);
});

test('R49: `undo --yes` refuses when the scaffold changed since, through the binary', async (t) => {
  const root = await freshRoot(t);
  const decided = await runCli(['decide', 'Undo me', '--root', root, '--yes']);
  assert.equal(decided.code, 0, decided.stderr.slice(0, 400));
  const [file] = await readdir(join(root, 'docs', 'decisions'));
  await writeFile(join(root, 'docs', 'decisions', file), 'hand edit\n', 'utf8');

  const undone = await runCli(['undo', '--root', root, '--yes', '--json']);
  assert.equal(undone.code, 1, 'a refused undo fails');
  const payload = JSON.parse(undone.stdout);
  assert.equal(payload.ok, false);
  assert.ok(payload.refused.path.endsWith(file));
  assert.equal(await readFile(join(root, 'docs', 'decisions', file), 'utf8'), 'hand edit\n');
});
