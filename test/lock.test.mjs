// Cache-stable rendering (R13, ADR-086).
//
// Two properties. A repository's own line changes only the tail of the region, so the
// prefix a reader has cached stays. And `check --frozen` fails when the projection
// moves without the inputs moving, which is the renderer failing to be a function of
// what it read.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { desiredRegion } from '../src/projection/rules.mjs';
import { computeLock, readLock, writeLockVariants } from '../src/projection/lock.mjs';
import { LOCK_FILE, LOCK_LEGACY } from '../src/name.mjs';
import { frozenFindings, syncCommand } from '../src/commands/sync.mjs';
import { plan } from '../src/projection/project.mjs';
import { initCommand } from '../src/commands/init.mjs';

async function capture(run) {
  const out = [];
  const err = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  process.stderr.write = (c) => { err.push(String(c)); return true; };
  let code;
  try {
    code = await run();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { code, text: `${out.join('')}${err.join('')}` };
}

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

test('a lock under the old name is read, and the next write migrates it (ADR-110)', async () => {
  const root = await repo();
  const lock = await computeLock(root, {});
  await writeFile(join(root, LOCK_LEGACY), `${JSON.stringify(lock, null, 2)}\n`);

  const { lock: read } = await readLock(root);
  assert.deepEqual(read, lock, 'the legacy file answers as a lock');
  assert.deepEqual(await frozenFindings(root, {}), [], 'a frozen check reads the legacy lock');

  await writeLockVariants(root, {});
  assert.equal(
    await readFile(join(root, LOCK_FILE), 'utf8'),
    `${JSON.stringify(lock, null, 2)}\n`,
    'the write lands under the new name',
  );
  assert.equal(
    await readFile(join(root, LOCK_LEGACY), 'utf8'),
    `${JSON.stringify(lock, null, 2)}\n`,
    'the legacy lock is read, never rewritten',
  );
  await rm(root, { recursive: true, force: true });
});

test('the lock is a target the plan produces (Q29)', async () => {
  const root = await repo();
  const result = await plan(root, {});
  const lockTarget = result.targets.find((t) => t.file === LOCK_FILE);
  assert.ok(lockTarget, 'the plan carries a lock target');
  assert.equal(lockTarget.kind, 'lock');
  assert.equal(lockTarget.action, 'create', 'a fresh repo has no lock, so the plan creates it');
  assert.equal(lockTarget.path, join(root, LOCK_FILE));
  // The bytes the plan will write are the lock this repo should have.
  const expected = `${JSON.stringify(await computeLock(root, {}), null, 2)}\n`;
  assert.equal(lockTarget.text, expected);
  await rm(root, { recursive: true, force: true });
});

test('a deleted lock is a write sync reports, not a silent no-op (Q29)', async () => {
  const root = await repo();
  // First sync writes the lock with everything else.
  const first = await capture(() => syncCommand([], { root, yes: true }));
  assert.equal(first.code, 0);
  assert.ok((await readFile(join(root, LOCK_FILE), 'utf8')).length > 0, 'the first sync wrote the lock');

  // Delete it. The next sync must show a write for the lock, not "nothing written".
  await rm(join(root, LOCK_FILE), { force: true });
  const again = await capture(() => syncCommand([], { root, yes: true }));
  assert.equal(again.code, 0);
  assert.ok(again.text.includes(LOCK_FILE), 'the plan names the lock it is writing');
  assert.ok(!again.text.includes('already current; nothing written'), 'a deleted lock is not a no-op');
  assert.ok((await readFile(join(root, LOCK_FILE), 'utf8')).length > 0, 'the lock is back on disk');

  // And once it is current, the run is idle again.
  const idle = await capture(() => syncCommand([], { root, yes: true }));
  assert.ok(idle.text.includes('already current; nothing written'), 'a current lock is not a write');
  await rm(root, { recursive: true, force: true });
});

test('init writes the lock, so check --frozen is green after adoption (Q29)', async () => {
  const root = await repo();
  const applied = await capture(() => initCommand([], { root, yes: true }));
  assert.equal(applied.code, 0);
  assert.ok((await readFile(join(root, LOCK_FILE), 'utf8')).length > 0, 'init wrote the lock');
  assert.deepEqual(await frozenFindings(root, {}), [], 'a frozen check is green after init');
  await rm(root, { recursive: true, force: true });
});
