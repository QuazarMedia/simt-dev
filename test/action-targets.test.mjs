// Plan 0004 W30: target identity and capability snapshots.
//
// The fixture is a target that was reset under the same hostname, an object id that exists in
// two tenants, and a session that expired. What the suite pins: identity is namespace plus
// incarnation, never a hostname; object keys are namespace-scoped; an expired session demands
// re-authentication and revalidation rather than a privilege switch; unknown identity blocks
// mutation; and a report carries no token.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  TARGET_SCHEMA,
  TARGET_STATES,
  buildTargetSnapshot,
  inspectTarget,
  objectKey,
  redactedTarget,
  resolveTargetAlias,
  targetIdentity,
} from '../src/actions/targets.mjs';

const snapshot = (over = {}) =>
  buildTargetSnapshot({
    name: 'staging',
    hostname: 'rates.example.test',
    namespace: 'rates/staging',
    incarnation: 'inc-1',
    platform: { name: 'vendor', revision: '2026.1' },
    actor: { id: 'sam', role: 'editor' },
    capabilities: ['read-object', 'write-object'],
    session: { state: 'valid', expiresAt: '2026-11-04T00:00:00Z' },
    observedAt: '2026-11-03T10:00:00Z',
    ...over,
  });

test('identity is namespace plus incarnation, and the schema says so', () => {
  assert.equal(TARGET_SCHEMA, 'simt.target/1');
  assert.deepEqual(TARGET_STATES, ['ready', 'unknown-identity', 'reauth-required', 'unsupported-operation']);
  assert.equal(targetIdentity({ namespace: 'a', incarnation: '1' }), 'a#1');
  assert.equal(targetIdentity({ namespace: 'a' }), null);
  assert.equal(targetIdentity({ hostname: 'a.test' }), null);
});

test('the same hostname after a reset is a different target', () => {
  const before = snapshot();
  const reset = snapshot({ incarnation: 'inc-2' });
  assert.equal(before.hostname, reset.hostname);
  assert.notEqual(before.identity, reset.identity);
  assert.equal(inspectTarget(before, { operation: 'write-object' }).identity, 'rates/staging#inc-1');
  assert.equal(inspectTarget(reset, { operation: 'write-object' }).identity, 'rates/staging#inc-2');
});

test('the same object id in two tenants never collides', () => {
  assert.equal(objectKey({ namespace: 'tenant-a', type: 'rule', id: '42' }), 'tenant-a:rule:42');
  assert.notEqual(objectKey({ namespace: 'tenant-a', type: 'rule', id: '42' }), objectKey({ namespace: 'tenant-b', type: 'rule', id: '42' }));
  assert.equal(objectKey({ namespace: 'tenant-a', type: 'rule' }), null);
});

test('aliases resolve locally, and an ambiguous alias resolves to nothing', () => {
  const targets = [
    { name: 'staging', alias: 'stg', namespace: 'rates/staging', incarnation: 'inc-1' },
    { name: 'prod', alias: 'prd', namespace: 'rates/prod', incarnation: 'inc-9' },
  ];
  assert.equal(resolveTargetAlias(targets, 'stg').identity, 'rates/staging#inc-1');
  assert.equal(resolveTargetAlias(targets, 'nope').error, 'unknown-alias');

  const ambiguous = [...targets, { name: 'other', alias: 'stg', namespace: 'rates/other', incarnation: 'inc-3' }];
  const clash = resolveTargetAlias(ambiguous, 'stg');
  assert.equal(clash.error, 'ambiguous-alias');
  assert.deepEqual(clash.candidates, ['other', 'staging']);
});

test('an expired session demands re-authentication, never a privilege switch', () => {
  const result = inspectTarget(snapshot(), { session: { state: 'expired' }, operation: 'write-object' });
  assert.equal(result.state, 'reauth-required');
  assert.equal(result.mayMutate, false);
  assert.match(result.reasons[0], /re-authenticate and re-observe/);
});

test('a snapshot observed for another actor is not switchable', () => {
  const result = inspectTarget(snapshot(), { actor: { id: 'someone-else' }, operation: 'write-object' });
  assert.equal(result.state, 'reauth-required');
  assert.equal(result.mayMutate, false);
  assert.match(result.reasons[0], /new authorization/);
});

test('unknown identity prevents mutation, whatever else the snapshot says', () => {
  const anonymous = { name: 'staging', hostname: 'rates.example.test', identity: null, capabilities: ['write-object'], actor: { id: 'sam' } };
  const result = inspectTarget(anonymous, { operation: 'write-object' });
  assert.equal(result.state, 'unknown-identity');
  assert.equal(result.mayMutate, false);
  assert.match(result.reasons[0], /hostname or display name is not an identity/);
});

test('a declared capability is required for the operation asked about', () => {
  const readOnly = snapshot({ capabilities: ['read-object'] });
  assert.equal(inspectTarget(readOnly, { operation: 'write-object' }).state, 'unsupported-operation');
  assert.equal(inspectTarget(readOnly, { operation: 'read-object' }).state, 'ready');
});

test('a read-only report contains no token, cookie or secret content', () => {
  const withSecret = buildTargetSnapshot({
    name: 'staging',
    namespace: 'rates/staging',
    incarnation: 'inc-1',
    session: { state: 'valid', token: 'ghp_abcdefghijklmnopqrstuvwxyz0123', cookie: 'session=abc' },
    credentials: { password: 'hunter2' },
  });
  const report = redactedTarget(withSecret);
  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /ghp_|hunter2|session=abc/);
  assert.deepEqual(Object.keys(report.session).sort(), ['expiresAt', 'state']);
  assert.equal(report.session.state, 'valid');
});

test('the snapshot is deterministic and the module reads nothing', async () => {
  assert.deepEqual(snapshot(), snapshot());
  const source = await readFile(new URL('../src/actions/targets.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
