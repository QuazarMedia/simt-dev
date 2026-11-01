// Ledger v2: a seeded index, a bounded read and a rotation (review 0003 Q75).
//
// The three costs the row names are all in this file: hashing every path on every gate run,
// reading a year of lines to answer "what just ran", and a file that grows without a bound.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from './fixture.mjs';
import { LEDGER_FILE, readLedgerTail, recordRun, rotateLedger, seedIndex } from '../src/ledger/index.mjs';
import { readEvents } from '../src/state/events.mjs';

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-ledger-v2-'));
  await git(['init', '-q', root]);
  await writeFile(join(root, 'a.txt'), 'a\n');
  await git(['-C', root, 'add', 'a.txt']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

test('a seeded index lists what the real index lists', async () => {
  const root = await repo();
  try {
    await writeFile(join(root, 'b.txt'), 'b\n');
    await git(['-C', root, 'add', 'b.txt']);
    const copy = join(root, 'seeded-index');
    assert.ok(await seedIndex(root, copy));
    const staged = (target) =>
      execFileSync('git', ['ls-files', '--stage'], {
        cwd: root,
        env: { ...process.env, GIT_INDEX_FILE: target },
        encoding: 'utf8',
      });
    assert.equal(staged(copy), staged(join(root, '.git', 'index')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a run records the command and the wall time under both names', async () => {
  const root = await repo();
  try {
    const line = await recordRun(root, { cmd: 'npm test', exit: 0, ms: 12, output: 'ok' });
    assert.equal(line.command, 'npm test');
    assert.equal(line.cmd, 'npm test');
    assert.equal(line.wallMs, 12);
    assert.equal(line.ms, 12);
    const { events } = await readEvents(root);
    assert.equal(events.filter((e) => e.kind === 'gate.finished').length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a tail read answers with the last entries and drops a half line', async () => {
  const root = await repo();
  try {
    for (let i = 0; i < 5; i += 1) {
      await recordRun(root, { cmd: `run ${i}`, exit: 0, ms: i, output: 'ok' });
    }
    const { entries } = await readLedgerTail(root, { entries: 2 });
    assert.deepEqual(entries.map((e) => e.command), ['run 3', 'run 4']);
    const sliced = await readLedgerTail(root, { entries: 10, bytes: 400 });
    assert.equal(sliced.partial, true);
    assert.ok(sliced.entries.length >= 1);
    assert.ok(sliced.entries.every((e) => typeof e.tree === 'string'), 'a half line was parsed as evidence');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a ledger past the ceiling archives the older half and keeps the newest', async () => {
  const root = await repo();
  try {
    const lines = Array.from({ length: 8 }, (_, i) =>
      JSON.stringify({ v: 2, tree: `t${i}`, exit: 0, cmd: `run ${i}` }),
    );
    await mkdir(join(root, '.simt', 'local'), { recursive: true });
    await writeFile(join(root, LEDGER_FILE), `${lines.join('\n')}\n`);
    const result = await rotateLedger(root, { maxLines: 4 });
    assert.deepEqual(result, { rotated: true, archived: 6, kept: 2 });
    const kept = (await readFile(join(root, LEDGER_FILE), 'utf8')).trim().split('\n');
    const archived = (await readFile(join(root, `${LEDGER_FILE}.1`), 'utf8')).trim().split('\n');
    assert.equal(kept.length, 2);
    assert.equal(archived.length, 6);
    assert.match(kept[1], /run 7/);
    assert.match(archived[0], /run 0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
