// `simt plan archive` (plan 0004 W04's neighbour, review 0003 Q99's close-out tool).
//
// Archiving is two claims in one move: the document leaves the live directory, and its
// status says every row is finished. The refusal cases are what keep the second claim
// true — an unfinished plan, a research note, and a document already archived are each
// refused by name rather than moved anyway.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { planArchive } from '../src/plan/archive.mjs';
import { planStatus } from '../src/plan/index.mjs';
import { tempDir } from './fixture.mjs';

const TRACKER = (rows, title = '# Review 0009 — a fixture') => `${title}

Status: open · 2026-11-01

| # | Slice | State |
| --- | --- | --- |
${rows.join('\n')}
`;

async function fixture(rows = ['| Q01 | first | Complete |', '| Q02 | second | Complete |'], title) {
  const root = await tempDir('archive-');
  const dir = join(root, 'docs', 'reviews');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(dir, { recursive: true }));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(join(dir, '0009-fixture-review.md'), TRACKER(rows, title)));
  return root;
}

test('a finished review moves to archive/ and its status says so', async () => {
  const root = await fixture();
  const before = await readFile(join(root, 'docs/reviews/0009-fixture-review.md'), 'utf8');
  const result = await planArchive(root, 'Q01', { dryRun: false, at: Date.UTC(2026, 10, 2) });
  assert.equal(result.error, undefined);
  assert.equal(result.from, 'docs/reviews/0009-fixture-review.md');
  assert.equal(result.to, 'docs/reviews/archive/0009-fixture-review.md');
  assert.equal(result.changed, true);

  assert.equal(existsSync(join(root, 'docs/reviews/0009-fixture-review.md')), false, 'the live copy is gone');
  const moved = await readFile(join(root, 'docs/reviews/archive/0009-fixture-review.md'), 'utf8');
  assert.match(moved, /^Status: \*\*closed\*\* — 2 row\(s\): 2 Complete · 2026-11-02$/m);
  assert.equal(moved.includes('Status: open'), false, 'the open status must not survive');
  assert.equal(moved.split('\n').length, before.split('\n').length, 'no line added or lost');

  // The tracker reads the archive recursively, so a finished document is still counted.
  const status = await planStatus(root);
  assert.equal(status.totals.complete, 2);
});

test('an unfinished plan is refused unless the caller forces it', async () => {
  const root = await fixture(['| Q01 | first | Complete |', '| Q02 | second | Queued |']);
  const refused = await planArchive(root, 'Q01', { dryRun: false });
  assert.match(refused.error, /1 unfinished row\(s\): Q02/);
  assert.match(refused.remedy, /--force --yes/);
  assert.equal(existsSync(join(root, 'docs/reviews/archive/0009-fixture-review.md')), false);

  const forced = await planArchive(root, 'Q01', { dryRun: false, force: true });
  assert.equal(forced.error, undefined);
  assert.equal(forced.unfinished, 1);
  const moved = await readFile(join(root, 'docs/reviews/archive/0009-fixture-review.md'), 'utf8');
  // The counts are the record, so a forced archive still says what was left open.
  assert.match(moved, /2 row\(s\): 1 Queued, 1 Complete/);
});

test('a research note is refused: it is not tracked work', async () => {
  const root = await tempDir('archive-');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(root, 'docs/research'), { recursive: true });
  await writeFile(join(root, 'docs/research/0009-notes.md'), TRACKER(['| Q01 | a | Complete |', '| Q02 | b | Complete |'], '# Notes on a fixture'));
  const result = await planArchive(root, 'Q01', { dryRun: false });
  assert.match(result.error, /neither a plan nor a review/);
  assert.equal(existsSync(join(root, 'docs/research/archive')), false);
});

test('a dry run reports the destination and the status without writing either', async () => {
  const root = await fixture();
  const before = await readFile(join(root, 'docs/reviews/0009-fixture-review.md'), 'utf8');
  const result = await planArchive(root, 'Q01');
  assert.equal(result.dryRun, true);
  assert.equal(result.changed, false);
  assert.equal(result.to, 'docs/reviews/archive/0009-fixture-review.md');
  assert.match(result.status, /^Status: \*\*closed\*\* — 2 row\(s\): 2 Complete/);
  assert.match(result.remedy, /plan archive Q01 --yes/);
  assert.equal(await readFile(join(root, 'docs/reviews/0009-fixture-review.md'), 'utf8'), before);
  assert.equal(existsSync(join(root, 'docs/reviews/archive')), false);
});

test('archiving twice is refused, and an unknown name says what was looked for', async () => {
  const root = await fixture();
  await planArchive(root, 'Q01', { dryRun: false });
  const again = await planArchive(root, 'Q01', { dryRun: false });
  assert.match(again.error, /no tracked document or slice named Q01|already in an archive directory/);

  const unknown = await planArchive(root, 'nothing-like-this', { dryRun: false });
  assert.match(unknown.error, /no tracked document or slice named nothing-like-this/);
});

test('a document can be named directly, so a closed review with no rows left still archives', async () => {
  const root = await fixture();
  const result = await planArchive(root, '0009-fixture-review.md', { dryRun: false });
  assert.equal(result.error, undefined);
  assert.equal(result.to, 'docs/reviews/archive/0009-fixture-review.md');
});

test('a document with no status line gains one under its title', async () => {
  const root = await tempDir('archive-');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(root, 'docs/plans'), { recursive: true });
  await writeFile(join(root, 'docs/plans/0009-a-plan.md'), `# Plan 0009 — a fixture\n\n| # | Slice | State |\n| --- | --- | --- |\n| Q01 | a | Complete |\n| Q02 | b | Complete |\n`);
  const result = await planArchive(root, 'Q01', { dryRun: false });
  assert.equal(result.statusInserted, true);
  const moved = await readFile(join(root, 'docs/plans/archive/0009-a-plan.md'), 'utf8');
  assert.match(moved, /^# Plan 0009 — a fixture\n\nStatus: \*\*closed\*\* — 2 row\(s\): 2 Complete/m);
});
