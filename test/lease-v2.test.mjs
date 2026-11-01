// Lease record v2 (review 0003 Q74).
//
// v1 stored a flat path and a session. v2 stores a resource, a holder and a fencing
// token, so a directory can be one claim and a lease can say which acquisition it is.
// The property that matters most is the one a release must not get wrong: a file written
// by the previous version is still honoured, because refusing it would silently release
// every path an older checkout holds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LEASE_FILE,
  fileLeaseStore,
  flattenLease,
  leaseCovers,
  readLeases,
  toV2,
  writeLeases,
} from '../src/lease.mjs';

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-lease-v2-'));
  await mkdir(join(root, 'src', 'index'), { recursive: true });
  return root;
}

test('a v1 record is read as a path resource with a holder and a fence', async () => {
  const root = await repo();
  await mkdir(join(root, '.simt', 'local'), { recursive: true });
  await writeFile(
    join(root, LEASE_FILE),
    `${JSON.stringify({ schemaVersion: 1, leases: [{ path: 'src/a.mjs', session: 'alpha', harness: 'claude', expiresAt: Date.now() + 60_000 }] })}\n`,
  );
  const { leases, error } = await readLeases(root);
  assert.equal(error, null);
  assert.equal(leases[0].resource.kind, 'path');
  assert.equal(leases[0].resource.id, 'src/a.mjs');
  assert.equal(leases[0].holder.session, 'alpha');
  assert.equal(leases[0].holder.harness, 'claude');
  assert.equal(leases[0].path, 'src/a.mjs');
  assert.equal(leases[0].session, 'alpha');
});

test('writing produces schema 2 with resource, holder, fence and both times', async () => {
  const root = await repo();
  await writeLeases(root, [
    toV2({ path: 'src/a.mjs', session: 'alpha', expiresAt: Date.now() + 60_000 }),
  ]);
  const { readFile } = await import('node:fs/promises');
  const document = JSON.parse(await readFile(join(root, LEASE_FILE), 'utf8'));
  assert.equal(document.schemaVersion, 2);
  const [record] = document.leases;
  assert.deepEqual(record.resource, { kind: 'path', id: 'src/a.mjs' });
  assert.deepEqual(record.holder, { session: 'alpha', harness: null });
  assert.equal(record.fence, 1);
  assert.ok('acquiredAt' in record);
  assert.ok(record.expiresAt > Date.now());
});

test('a directory claim covers what is under it, and not a sibling with the prefix', () => {
  const dir = flattenLease({ resource: { kind: 'dir', id: 'src/index' }, holder: { session: 'a' }, fence: 1, expiresAt: 1 });
  assert.equal(leaseCovers(dir, 'src/index/persist.mjs'), true);
  assert.equal(leaseCovers(dir, 'src/index'), true);
  assert.equal(leaseCovers(dir, 'src/indexer/x.mjs'), false);
  const file = flattenLease({ resource: { kind: 'path', id: 'src/a.mjs' }, holder: { session: 'a' }, fence: 1, expiresAt: 1 });
  assert.equal(leaseCovers(file, 'src/a.mjs'), true);
  assert.equal(leaseCovers(file, 'src/b.mjs'), false);
});

test('an entry with a bad expiry is dropped, not honoured forever', async () => {
  const root = await repo();
  await mkdir(join(root, '.simt', 'local'), { recursive: true });
  await writeFile(
    join(root, LEASE_FILE),
    `${JSON.stringify({ schemaVersion: 2, leases: [{ resource: { kind: 'path', id: 'a' }, holder: { session: 'x' }, fence: 1, expiresAt: 'never' }] })}\n`,
  );
  const { leases } = await readLeases(root);
  assert.deepEqual(leases, []);
});

test('the file store is the interface the commands use', async () => {
  const root = await repo();
  const store = fileLeaseStore(root);
  await store.write([toV2({ path: 'a.mjs', session: 'alpha', expiresAt: Date.now() + 1000 })]);
  const { leases } = await store.read();
  assert.equal(leases.length, 1);
  const fenced = await store.withLock(async () => leases[0].fence);
  assert.equal(fenced, 1);
});
