// The write journal and `simt undo` (plan 0003 R49).
//
// The acceptance is the round trip: every write a command records can be
// restored, and only when untouched since. The unit tests below drive the
// journal directly (modify, create, remove); the command tests go through the
// real binary, because that is the only way to catch a writer the dispatcher
// never journals.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  commitJournal,
  journaledCopyDir,
  journaledGitConfig,
  journaledRemoveFile,
  journaledWriteFile,
  listJournalSets,
  readGitValue,
  undoLastJournalSet,
} from '../src/journal.mjs';
import { LOCAL_DIR } from '../src/state.mjs';

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

test('Q22: a binary file overwritten by a text write comes back byte-for-byte', async (t) => {
  const root = await freshRoot(t);
  const p = join(root, 'blob.bin');
  const bytes = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x0a, 0x1b]);
  await writeFile(p, bytes);

  const journal = [];
  await journaledWriteFile(root, journal, p, 'text now\n');
  await commitJournal(root, 'test', journal);

  const result = await undoLastJournalSet(root);
  assert.ok(!('refused' in result && result.refused), JSON.stringify(result.refused));
  assert.ok((await readFile(p)).equals(bytes), 'the utf8 round trip corrupted the binary');
});

test('Q22: a mode change rides with the write and is restored with the bytes', async (t) => {
  const root = await freshRoot(t);
  const p = join(root, 'run.sh');
  await writeFile(p, 'old\n', { mode: 0o644 });

  const journal = [];
  await journaledWriteFile(root, journal, p, 'new\n', { mode: 0o755 });
  assert.equal((await stat(p)).mode & 0o777, 0o755);
  await commitJournal(root, 'test', journal);

  const result = await undoLastJournalSet(root);
  assert.ok(!('refused' in result && result.refused), JSON.stringify(result.refused));
  assert.equal(await readFile(p, 'utf8'), 'old\n');
  assert.equal((await stat(p)).mode & 0o777, 0o644);
});

test('Q22: two writes to one path fold to first-before last-after, and restore', async (t) => {
  const root = await freshRoot(t);
  const p = join(root, 'f.md');
  await writeFile(p, 'one\n', 'utf8');

  const journal = [];
  await journaledWriteFile(root, journal, p, 'ONE\n');
  await journaledWriteFile(root, journal, p, '1\n');
  const id = await commitJournal(root, 'test', journal);
  assert.ok(id, 'the folded entry is still a change');

  const result = await undoLastJournalSet(root);
  assert.ok(!('refused' in result && result.refused), JSON.stringify(result.refused));
  assert.deepEqual(result.restored, ['f.md']);
  assert.equal(await readFile(p, 'utf8'), 'one\n');
});

test('Q22: write-then-remove folds to one removal, create-then-remove to nothing', async (t) => {
  const root = await freshRoot(t);
  const kept = join(root, 'kept.md');
  await writeFile(kept, 'kept\n', 'utf8');

  const journal = [];
  await journaledWriteFile(root, journal, kept, 'changed\n');
  await journaledRemoveFile(root, journal, kept);
  await commitJournal(root, 'test', journal);
  const back = await undoLastJournalSet(root);
  assert.ok(!('refused' in back && back.refused), JSON.stringify(back.refused));
  assert.equal(await readFile(kept, 'utf8'), 'kept\n');

  const noop = [];
  await journaledWriteFile(root, noop, join(root, 'temp.md'), 'brief\n');
  await journaledRemoveFile(root, noop, join(root, 'temp.md'));
  assert.equal(await commitJournal(root, 'test', noop), null, 'a create-then-remove is no change at all');
  assert.deepEqual(await listJournalSets(root), [], 'no set was committed for the no-op');
});

test('Q22: restore runs in reverse entry order', async (t) => {
  const root = await freshRoot(t);
  const a = join(root, 'a.md');
  const b = join(root, 'b.md');
  await writeFile(a, 'a1\n', 'utf8');
  await writeFile(b, 'b1\n', 'utf8');

  const journal = [];
  await journaledWriteFile(root, journal, a, 'a2\n');
  await journaledWriteFile(root, journal, b, 'b2\n');
  await commitJournal(root, 'test', journal);

  const result = await undoLastJournalSet(root);
  assert.deepEqual(result.restored, ['b.md', 'a.md'], 'later writes unwind first');
});

test('Q22: a crashed undo resumes from its marker instead of refusing its own progress', async (t) => {
  const root = await freshRoot(t);
  const a = join(root, 'a.md');
  const b = join(root, 'b.md');
  await writeFile(a, 'a1\n', 'utf8');
  await writeFile(b, 'b1\n', 'utf8');

  const journal = [];
  await journaledWriteFile(root, journal, a, 'a2\n');
  await journaledWriteFile(root, journal, b, 'b2\n');
  const id = await commitJournal(root, 'test', journal);

  // The crash, staged by hand: one file already back at its pre-run bytes, and
  // the marker the interrupted undo left behind.
  await writeFile(a, 'a1\n', 'utf8');
  await writeFile(
    join(root, LOCAL_DIR, 'journal', `${id}.undoing.json`),
    `${JSON.stringify({ version: 1, set: id, at: Date.now() }, null, 2)}\n`,
  );

  const result = await undoLastJournalSet(root);
  assert.ok(!('refused' in result && result.refused), JSON.stringify(result.refused));
  assert.equal(result.resumed, true);
  assert.equal(await readFile(a, 'utf8'), 'a1\n');
  assert.equal(await readFile(b, 'utf8'), 'b1\n');
  assert.equal(
    (await readdir(join(root, LOCAL_DIR, 'journal'))).filter((n) => n.endsWith('.undoing.json')).length,
    0,
    'the marker is removed when the resumed undo completes',
  );
});

test('Q22: a version-1 set with utf8 beforeBytes still restores', async (t) => {
  const root = await freshRoot(t);
  const digestOf = (s) => `sha256-${createHash('sha256').update(s).digest('hex')}`;
  const before = 'before\n';
  const after = 'after\n';
  const id = '2000-01-01T00-00-00-000Z-test-1.json';
  await mkdir(join(root, LOCAL_DIR, 'journal'), { recursive: true });
  await writeFile(
    join(root, LOCAL_DIR, 'journal', id),
    `${JSON.stringify({ version: 1, command: 'test', at: 0, entries: [{ path: 'a.md', beforeDigest: digestOf(before), afterDigest: digestOf(after), beforeBytes: before }] }, null, 2)}\n`,
  );
  await writeFile(join(root, 'a.md'), after, 'utf8');

  const result = await undoLastJournalSet(root);
  assert.ok(!('refused' in result && result.refused), JSON.stringify(result.refused));
  assert.equal(await readFile(join(root, 'a.md'), 'utf8'), before);
});

test('Q22: git config keys round-trip through the journal', async (t) => {
  const root = await freshRoot(t);

  const first = [];
  const set = await journaledGitConfig(root, first, 'simt.test.key', 'one');
  assert.deepEqual(set, { kind: 'git-config', key: 'simt.test.key', before: null, after: 'one' });
  assert.equal(await readGitValue(root, 'simt.test.key'), 'one');
  // Setting the value already there records nothing: no state to restore.
  assert.equal(await journaledGitConfig(root, first, 'simt.test.key', 'one'), null);
  assert.equal(first.length, 1);
  await commitJournal(root, 'test', first);

  const undone = await undoLastJournalSet(root);
  assert.ok(!('refused' in undone && undone.refused), JSON.stringify(undone.refused));
  assert.deepEqual(undone.restored, ['git config simt.test.key']);
  assert.equal(await readGitValue(root, 'simt.test.key'), null);

  // A changed value restores to the previous value, not to unset.
  await journaledGitConfig(root, [], 'simt.test.key', 'two');
  const second = [];
  await journaledGitConfig(root, second, 'simt.test.key', 'three');
  await commitJournal(root, 'test', second);
  const back = await undoLastJournalSet(root);
  assert.ok(!('refused' in back && back.refused), JSON.stringify(back.refused));
  assert.equal(await readGitValue(root, 'simt.test.key'), 'two');
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
