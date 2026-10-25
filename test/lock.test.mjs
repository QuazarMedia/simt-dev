// Cache-stable rendering (R13, ADR-086).
//
// Two properties. A repository's own line changes only the tail of the region, so the
// prefix a reader has cached stays. And `check --frozen` fails when the projection
// moves without the inputs moving, which is the renderer failing to be a function of
// what it read.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { desiredRegion } from '../src/projection/rules.mjs';
import { computeLock, LOCK_FILE } from '../src/projection/lock.mjs';
import { frozenFindings } from '../src/commands/sync.mjs';

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-lock-'));
  await mkdir(join(root, '.simt', 'profiles'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{ "name": "x", "scripts": { "test": "node --test" } }\n');
  await writeFile(
    join(root, '.simt', 'profiles', 'house-local.md'),
    '---\nsimt-id: house-local\nsimt-title: House\nsimt-applies: [node]\n---\n\n# House\n\nThe house line.\n',
  );
  return root;
}

test('two renders of one repository are the same bytes', async () => {
  const root = await repo();
  const a = await desiredRegion(root, {});
  const b = await desiredRegion(root, {});
  assert.equal(a.body, b.body);
  await rm(root, { recursive: true, force: true });
});

test('editing a repository line changes only the tail', async () => {
  const root = await repo();
  const before = (await desiredRegion(root, {})).body;
  const at = before.indexOf('## Stack: house-local');
  assert.ok(at > before.indexOf('## Core'), 'the house profile follows the shipped rules');
  assert.ok(at > before.indexOf('Commands for this repository:'), 'the house profile follows the card');
  const prefix = before.slice(0, at);

  await writeFile(
    join(root, '.simt', 'profiles', 'house-local.md'),
    '---\nsimt-id: house-local\nsimt-title: House\nsimt-applies: [node]\n---\n\n# House\n\nThe edited house line.\n',
  );
  const after = (await desiredRegion(root, {})).body;
  assert.ok(after.startsWith(prefix), 'the bytes before the repository profile moved');
  assert.equal(before.startsWith(prefix), true);
  assert.ok(after.includes('The edited house line.'));
  assert.equal(after.includes('The house line.\n'), false);
  await rm(root, { recursive: true, force: true });
});

test('a frozen check names which of the two lock failures it is', async () => {
  const root = await repo();
  const absent = await frozenFindings(root, {});
  assert.equal(absent[0].status, 'lock-absent');

  const lock = await computeLock(root, {});
  await writeFile(join(root, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  assert.deepEqual(await frozenFindings(root, {}), []);

  await writeFile(join(root, LOCK_FILE), `${JSON.stringify({ ...lock, outputs: '0'.repeat(64) }, null, 2)}\n`);
  const unexplained = await frozenFindings(root, {});
  assert.equal(unexplained[0].status, 'lock-unexplained');

  await writeFile(
    join(root, '.simt', 'profiles', 'house-local.md'),
    '---\nsimt-id: house-local\nsimt-title: House\nsimt-applies: [node]\n---\n\n# House\n\nA different line.\n',
  );
  await writeFile(join(root, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  const stale = await frozenFindings(root, {});
  assert.equal(stale[0].status, 'lock-stale');
  await rm(root, { recursive: true, force: true });
});
