// Plan 0004 W37: resource leases with honest fencing.
//
// What the suite pins: a resource key carries the target and incarnation, so a reset target is a
// different resource and a local worktree cannot stand in for one; two owners cannot hold one
// exclusive lease; an expired lease can be taken; a worker behind the fencing token cannot mutate;
// resources are acquired in one canonical order; a lease without an enforcing authority is
// advisory and states its residual race; and no lease grants a privilege.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ENFORCEMENT,
  LEASE_SCHEMA,
  acquire,
  checkFencing,
  enforcementFor,
  grantsOf,
  orderResources,
  release,
  resourceKey,
} from '../src/coordination/leases.mjs';

const remoteKey = (over = {}) => resourceKey({ target: 'rates/prod', incarnation: 'inc-9', type: 'object', object: 'rule-42', ...over });

test('the schema and the enforcement modes are named', () => {
  assert.equal(LEASE_SCHEMA, 'simt.lease/1');
  assert.deepEqual(ENFORCEMENT, ['enforced', 'advisory-local', 'advisory-cross-host']);
});

test('a remote key carries the target and incarnation; a local key carries a path', () => {
  assert.equal(remoteKey(), 'rates/prod#inc-9/object/object/rule-42');
  assert.notEqual(remoteKey(), remoteKey({ incarnation: 'inc-10' }));
  assert.notEqual(remoteKey(), remoteKey({ target: 'rates/staging' }));
  assert.equal(resourceKey({ target: 'rates/prod', incarnation: 'inc-9', type: 'object' }), null);
  assert.equal(resourceKey({ type: 'file', path: 'docs/rates.md' }), 'local/file/docs/rates.md');
  assert.equal(resourceKey({ type: 'file' }), null);
  assert.equal(resourceKey({ target: 't', incarnation: 'i', type: 'collection', collection: 'rules', createKey: 'rates/v2' }), 't#i/collection/collection/rules~rates/v2');
});

test('a local worktree key is not a remote object key', () => {
  assert.notEqual(resourceKey({ type: 'worktree', path: 'rates/prod' }), remoteKey());
  assert.match(resourceKey({ type: 'worktree', path: 'wt' }), /^local\/worktree\//);
});

test('two owners cannot hold one exclusive lease', () => {
  const first = acquire({ held: [], key: remoteKey(), owner: 'session-a', ttl: 1000, now: 0 });
  assert.equal(first.granted, true);
  const second = acquire({ held: first.held, key: remoteKey(), owner: 'session-b', ttl: 1000, now: 10 });
  assert.equal(second.granted, false);
  assert.equal(second.holder, 'session-a');

  const again = acquire({ held: first.held, key: remoteKey(), owner: 'session-a', ttl: 1000, now: 10 });
  assert.equal(again.granted, true);
});

test('an expired lease can be taken, and an unkeyed one is refused', () => {
  const first = acquire({ held: [], key: remoteKey(), owner: 'session-a', ttl: 100, now: 0 });
  const taken = acquire({ held: first.held, key: remoteKey(), owner: 'session-b', ttl: 100, now: 500 });
  assert.equal(taken.granted, true);
  assert.equal(taken.lease.fencing, 1);
  assert.equal(acquire({ held: [], key: null, owner: 'x' }).granted, false);
  assert.equal(acquire({ held: [], key: remoteKey(), owner: null }).granted, false);
});

test('a worker behind the fencing token cannot mutate', () => {
  const lease = { key: remoteKey(), owner: 'session-a', fencing: 7, expiresAt: 1000 };
  assert.equal(checkFencing({ lease, token: 6 }).valid, false);
  assert.match(checkFencing({ lease, token: 6 }).reason, /behind the lease's fencing token/);
  assert.equal(checkFencing({ lease, token: 7 }).valid, true);
});

test('resources are acquired in one canonical order', () => {
  assert.deepEqual(orderResources(['b', 'a', 'b', '', 'c']), ['a', 'b', 'c']);
  const a = orderResources([remoteKey(), 'local/file/x']);
  const b = orderResources(['local/file/x', remoteKey()]);
  assert.deepEqual(a, b);
});

test('a lease without an enforcing authority is advisory and states its race', () => {
  const crossHost = enforcementFor({ host: 'laptop', leaseHost: 'laptop' });
  assert.equal(crossHost.mode, 'advisory-local');
  assert.match(crossHost.residualRace, /another process on this host/);

  const elsewhere = enforcementFor({ host: 'laptop', leaseHost: 'ci' });
  assert.equal(elsewhere.mode, 'advisory-cross-host');
  assert.match(elsewhere.reason, /not a distributed lock/);

  assert.equal(enforcementFor({ coordinator: 'http://coordinator' }).mode, 'enforced');
  assert.equal(enforcementFor({ serverCas: true }).mode, 'enforced');
});

test('a lease grantees nothing beyond exclusion, and release removes only your own', () => {
  const lease = acquire({ held: [], key: remoteKey(), owner: 'session-a' }).lease;
  assert.deepEqual(grantsOf(lease), []);
  const held = [
    { key: 'a', owner: 'session-a' },
    { key: 'b', owner: 'session-b' },
  ];
  const released = release({ held, key: 'a', owner: 'session-a' });
  assert.equal(released.released, true);
  assert.deepEqual(released.held.map((entry) => entry.key), ['b']);
  assert.equal(release({ held, key: 'b', owner: 'session-a' }).released, false);
});

test('the module is deterministic and reads nothing', async () => {
  assert.deepEqual(acquire({ held: [], key: 'k', owner: 'o', now: 0 }), acquire({ held: [], key: 'k', owner: 'o', now: 0 }));
  const source = await readFile(new URL('../src/coordination/leases.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
